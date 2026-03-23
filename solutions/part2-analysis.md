# 第二部分：架构治理分析

## 问题根因分析

### 1. 发现的问题点

在原始代码中发现了以下问题：

| 位置 | 问题 | 严重程度 |
|------|------|----------|
| `AnalysisService.createAnalysis()` | 在 API 层计算 `quickDemographics` 并写入 DB | 严重 |
| `AnalysisService.delayedUpdate()` | 2 秒后 `setTimeout` 无条件覆盖 DB 中的 demographics | 致命 |
| `AnalysisProcessor.process()` | Worker 也在写入 demographics，与 API 冲突 | 严重 |
| `DatabaseService.updateJob()` | 无版本控制，任何写入都会成功，无法防止覆盖 | 严重 |
| `AnalysisService.calculateQuickDemographics()` | 完全随机的假数据，用低置信度 0.3 写入 DB | 设计错误 |

根本原因：**两个服务（LegacyApp API + WorkerService）都在写同一条 MongoDB 记录，没有任何协调机制**。

### 2. 竞态条件详解

```
时间线：
T0: 用户发起 POST /api/analysis
T1: API 生成 jobId，计算 quickDemographics（随机数据，confidence=0.3）
T2: API 将 {status: PENDING, demographics: quickDemographics} 写入 MongoDB
T3: API 发送 AnalysisRequested 事件到队列
T4: API 返回响应给用户（用户看到 demographics = 随机数据）
T5: Worker 收到事件，设置 status = PROCESSING
T6: Worker 调用第三方 API，获得真实数据
T7: Worker 将 {status: COMPLETED, demographics: 真实数据} 写入 MongoDB
    （用户刷新页面 → 看到真实数据）
T8: API 的 setTimeout(2000) 触发 delayedUpdate()
T9: API 无条件用 quickDemographics（随机数据）覆盖 Worker 的正确结果！！
    （用户再次刷新 → 看到随机数据 → "闪烁"）
```

**核心矛盾**：Worker 可能在 2 秒内完成处理（T5-T7），但 `setTimeout` 固定在 2 秒后执行（T8-T9），导致正确的结果被覆盖。

## 我的重构方案

### 1. 设计原则

**Single Writer Pattern（单写者模式）**：对于 `analysis_jobs` 表中每条记录的**计算结果和状态转换**，只允许 Worker 进行写入。API 只负责创建 PENDING 记录和发布事件。

配合 **Optimistic Locking（乐观锁）**：每条记录附带 `version` 字段，每次写入必须携带预期版本号，版本不匹配则拒绝写入。

### 2. 具体修改

#### LegacyApp 修改

**`analysis.service.ts`** — 彻底移除 3 个方法：

- 删除 `calculateQuickDemographics()` — API 不应做计算
- 删除 `delayedUpdate()` — 消除竞态条件的根源
- 删除 `setTimeout()` 调用

重构后 `createAnalysis()` 只做：
1. 生成 jobId + traceId
2. 创建 `{status: 'PENDING'}` 记录到 DB（无 demographics）
3. 发布事件到队列
4. 返回响应

```typescript
async createAnalysis(dto: CreateAnalysisDto): Promise<AnalysisJob> {
    const jobId = uuidv4();
    const traceId = uuidv4();
    const now = new Date().toISOString();

    const job: AnalysisJob = {
        jobId,
        userId: dto.userId,
        dataUrl: dto.dataUrl,
        status: 'PENDING',   // 只创建 PENDING 状态，不写入 demographics
        createdAt: now,
        updatedAt: now,
    };

    await this.databaseService.saveJob(job);       // 写入 DB（version=1）
    await this.messageQueueService.publishEvent({   // 发布事件
        eventType: 'AnalysisRequested',
        jobId, userId: dto.userId, dataUrl: dto.dataUrl,
        timestamp: now, traceId,
    });

    return job;
}
```

**`database.service.ts`** — 新增乐观锁方法：

```typescript
async updateJobWithVersion(
    jobId: string,
    updates: Partial<AnalysisJob>,
    expectedVersion: number,
): Promise<boolean> {
    const result = await collection.updateOne(
        { jobId, version: expectedVersion },       // 条件：版本必须匹配
        {
            $set: { ...updates, updatedAt: new Date().toISOString() },
            $inc: { version: 1 },                  // 自动递增版本
        },
    );
    return result.matchedCount > 0;  // false = 版本冲突，写入被拒绝
}
```

#### WorkerService 修改

**`analysis.processor.ts`** — 使用乐观锁进行状态转换：

```
PENDING (v=1) → PROCESSING (v=2) → COMPLETED (v=3)
```

每次 `updateJobVersioned()` 都携带预期版本号，如果版本冲突（说明有其他 Writer 已修改），则跳过并打印警告。

### 3. 状态机设计

```
创建（API）          处理（Worker only）
   │                    │
   ▼                    ▼
PENDING ──────► PROCESSING ──────► COMPLETED
  (v=1)          (v=2)               (v=3)
                   │
                   ▼
                 FAILED
                  (v=3)
```

规则：
- API 只能创建 `PENDING`，version=1
- 只有 Worker 可以 `PENDING → PROCESSING`（需 v=1）
- 只有 Worker 可以 `PROCESSING → COMPLETED/FAILED`（需 v=2）
- 任何版本冲突的写入会被乐观锁拒绝，不会覆盖已有数据

## 测试脚本

测试脚本位于 `scripts/test-part2-single-writer.ts`，包含 5 个测试：

| 测试 | 验证内容 |
|------|----------|
| Test 1 | API 创建 PENDING 状态 job，无 demographics，version=1 |
| Test 2 | Worker 完成完整状态转换 PENDING → PROCESSING → COMPLETED |
| Test 3 | 乐观锁拒绝过期版本（v=3 写入 v=5 记录） |
| Test 4 | 被拒绝后数据保持不变 |
| Test 5 | 并发处理不会导致数据闪烁（模拟两个 Worker 同时处理同一 job） |

运行方式：`npx tsx scripts/test-part2-single-writer.ts`

## 验收结果

```
=== Part 2: Single Writer Pattern & Optimistic Locking Test ===

Test 1: API creates job in PENDING state without demographics
  PASS: Job is PENDING, no demographics, version=1

Test 2: Worker drives all state transitions
[AnalysisProcessor] Connected to MongoDB
[jobId=c7e61775-... traceId=9538baf0-...] Processing started
[jobId=c7e61775-... traceId=9538baf0-...] Processing completed successfully
  PASS: status=COMPLETED, version=3, demographics=present

Test 3: Optimistic locking rejects stale version writes
  PASS: Stale write (version=3 vs current=5) correctly rejected
  PASS: Data remains unchanged after rejected stale write

Test 4: Concurrent processing does not cause data flickering
[jobId=5540824d-... traceId=5c7b8615-...] Processing started
[jobId=5540824d-... traceId=419dff91-...] Processing started
[jobId=5540824d-... traceId=419dff91-...] Processing completed successfully
[jobId=5540824d-... traceId=5c7b8615-...] Version conflict when setting COMPLETED
  PASS: No flickering detected, final status=COMPLETED,
        snapshots=[COMPLETED, COMPLETED, COMPLETED, COMPLETED, COMPLETED]

--- Results: 5 passed, 0 failed ---
```

关键验证点：Test 4 中两个 Worker 同时处理同一个 job，第二个 Worker 在设置 COMPLETED 时因版本冲突被拒绝，数据没有闪烁。这正是用户反馈的 "刷新后数据变了" 问题的修复。
