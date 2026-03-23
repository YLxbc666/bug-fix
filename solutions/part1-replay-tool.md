# 第一部分：Replay 工具实现记录

## 我的方案

实现了一个完整的**事件捕获 + 本地重放**机制，使开发者无需部署到云端即可在本地调试 Worker 处理逻辑。

核心设计分为两个部分：

1. **事件捕获**：在 `MessageQueueService.publishEvent()` 中，每次发布事件到队列时自动保存一份副本到 `debug-payloads/job-{jobId}.json`。这样开发者无需手动构造测试数据，任何经过 API 的真实请求都会被捕获。

2. **本地重放**：实现 `scripts/replay-event.ts`，从磁盘读取捕获的 JSON 文件，直接调用 `AnalysisProcessor.process(event)` 处理，完全绕过队列轮询。支持 `pnpm run replay -- --file=debug-payloads/job-xxx.json` 命令。

关键设计决策：
- Replay 直接复用 Worker 的 `AnalysisProcessor`，确保重放和生产路径完全一致
- 捕获文件命名为 `job-{jobId}.json`，方便按 jobId 查找
- 脚本包含参数校验、文件存在性检查、JSON 解析校验等防御性逻辑

## 关键代码

### 事件捕获 — `message-queue.service.ts`

```typescript
async publishEvent(event: AnalysisRequestedEvent): Promise<void> {
    const payload = JSON.stringify(event, null, 2);
    const filename = `${event.jobId}-${Date.now()}.json`;

    // 写入队列（Worker 消费）
    fs.writeFileSync(path.join(QUEUE_DIR, filename), payload);

    // 同时写入 debug-payloads/（捕获用于重放）
    const captureFile = `job-${event.jobId}.json`;
    fs.writeFileSync(path.join(CAPTURE_DIR, captureFile), payload);

    this.logger.log(
        `Published event | type=${event.eventType} jobId=${event.jobId} traceId=${event.traceId ?? 'N/A'}`,
    );
}
```

### 重放脚本 — `scripts/replay-event.ts`

```typescript
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const filePath = path.resolve(process.cwd(), fileArg.split('=')[1]);
const event: AnalysisRequestedEvent = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

const processor = new AnalysisProcessor();
await processor.ensureConnected();
await processor.process(event);
```

## 遇到的问题和解决方法

1. **Worker 构造函数中异步初始化 DB**：原始 `AnalysisProcessor` 在构造函数中调用 `initializeDatabase()`，这是一个 fire-and-forget 的异步操作，replay 脚本调用时 DB 可能还没连上。解决方法：将其改为显式的 `ensureConnected()` 方法，replay 脚本和 Worker 主入口都先 `await processor.ensureConnected()` 再开始处理。

2. **路径解析**：`process.cwd()` 在不同调用位置可能不同。使用 `path.resolve(process.cwd(), ...)` 确保相对路径正确解析。

## 测试脚本

测试脚本位于 `scripts/test-part1-replay.ts`，包含 3 个测试：

| 测试 | 验证内容 |
|------|----------|
| Test 1 | 捕获文件正确创建，包含正确的 jobId 和 traceId |
| Test 2 | 重放处理事件后 DB 中 job 状态变为 COMPLETED/FAILED |
| Test 3 | 从文件读取 → 解析 → 重放的完整 round-trip |

运行方式：`npx tsx scripts/test-part1-replay.ts`

## 验收结果

```
=== Part 1: Replay Tool Test ===

Test 1: Event capture file creation
  PASS: Capture file created with correct jobId and traceId

Test 2: Replay processes captured event and updates DB
[AnalysisProcessor] Connected to MongoDB
[jobId=ef8a83f5-... traceId=4f7babbc-...] Processing started
[jobId=ef8a83f5-... traceId=4f7babbc-...] Processing completed successfully
  PASS: Job status after replay = COMPLETED

Test 3: Replay from file (round-trip)
[jobId=c8128baa-... traceId=da862074-...] Processing started
[jobId=c8128baa-... traceId=da862074-...] Processing completed successfully
  PASS: Round-trip replay succeeded, status = COMPLETED

--- Results: 3 passed, 0 failed ---
```
