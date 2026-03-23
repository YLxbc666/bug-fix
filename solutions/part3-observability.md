# 第三部分：可观测性与容错

## 脏数据分析

### 发现的问题类型

对 `chaos-data-samples.json` 中的 12 条记录逐一分析：

| 记录 ID | 问题字段 | 期望类型 | 实际值 | 问题描述 |
|---------|----------|----------|--------|----------|
| record-002 | age | number | `"25+"` | 字符串而非数字 |
| record-002 | tags | string[] | `"tech,gaming,esports"` | 逗号分隔字符串而非数组 |
| record-002 | engagementScore | number | `"0.72"` | 字符串数字 |
| record-003 | age | number | `null` | 缺失 |
| record-003 | email | string(email) | `"invalid-email"` | 不合法邮箱格式 |
| record-004 | gender | string | `undefined` | 字段缺失 |
| record-004 | tags | string[] | `[]` | 空数组 |
| record-004 | engagementScore | number | `null` | 缺失 |
| record-005 | age | number | `"thirty"` | 无法解析的文本 |
| record-007 | age | number(>=0) | `-5` | 负数，不合理 |
| record-007 | engagementScore | number(0-1) | `1.5` | 超出 [0,1] 范围 |
| record-008 | age | number | `undefined` | 字段缺失 |
| record-009 | gender, country, city, tags, engagementScore, email | 各类型 | 全部 `null` | 几乎所有字段缺失 |
| record-012 | age | number | `"18-24"` | 范围字符串而非数字 |
| record-012 | tags | string[] | `"kpop,beauty,skincare"` | 逗号分隔字符串 |
| record-012 | engagementScore | number | `"high"` | 无法解析的文本 |

## 我的解决方案

### 1. Runtime Validation 实现

使用 **Zod** 进行运行时校验。选择 Zod 而非 class-validator 的原因：
- 纯函数式 API，不依赖装饰器和 class 实例
- 更好的 TypeScript 类型推断
- `safeParse()` 不抛异常，适合批处理场景

**Schema 定义：**

```typescript
import { z } from 'zod';

const ChaosRecordSchema = z.object({
    id: z.string(),
    age: z.number().int().min(0).max(150),
    gender: z.string().min(1),
    country: z.string().min(1),
    city: z.string().min(1),
    tags: z.array(z.string()).min(1),
    engagementScore: z.number().min(0).max(1),
    email: z.string().email(),
});
```

**预处理 normalize 管道**：在校验前尝试修复可自动修复的脏数据：

```typescript
function normalizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
    const out = { ...raw };
    // "25" → 25（数字字符串转数字）
    if (typeof out.age === 'string') {
        const num = parseInt(out.age as string, 10);
        if (isFinite(num)) out.age = num;
    }
    // "tech,gaming" → ["tech", "gaming"]（逗号分隔字符串转数组）
    if (typeof out.tags === 'string') {
        out.tags = (out.tags as string).split(',').map(t => t.trim()).filter(Boolean);
    }
    // "0.72" → 0.72（字符串转数字）
    if (typeof out.engagementScore === 'string') {
        const num = parseFloat(out.engagementScore as string);
        if (isFinite(num)) out.engagementScore = num;
    }
    return out;
}
```

### 2. 错误处理策略

**批处理级别** (`scripts/process-chaos.ts`)：
- 逐条处理，单条失败不影响其他记录
- 有效记录正常计入 `processed`
- 无效记录记录到 `failed` 数组，包含原始数据和所有校验错误
- 最终输出统计，将失败记录持久化到 `failed-records/batch-{timestamp}.json`

**Worker 级别** (`analysis.processor.ts`)：
- `transformApiResponse()` 完全重写，每个字段都有防御性处理：
  - `age`: null/undefined → `'unknown'`；字符串 → 尝试 parseInt；非法值 → 保留原文
  - `gender`/`country`: 非字符串 → `'unknown'`
  - `tags`: 字符串 → `split(',')` 转数组；null → undefined
  - `score`: 字符串数字 → parseFloat；夹紧到 [0,1] 范围
- 任何单个字段的异常不会导致整个 job 失败

**QueuePoller 级别**：
- 处理失败的消息自动移入 `failed-records/`，附带错误原因和时间戳
- 不会卡在一条消息上反复重试

### 3. 日志改进

```typescript
// ====== BEFORE ======
console.log('Error happened');           // 无任何上下文
console.log('Processing job: ' + jobId); // 只有 jobId
console.log('DB connection failed');     // 无错误详情

// ====== AFTER ======
// 每条日志包含结构化标签
const tag = `[jobId=${jobId} traceId=${traceId ?? 'N/A'}]`;

console.log(`${tag} Processing started`);
console.log(`${tag} Processing completed successfully`);
console.error(`${tag} Processing failed: ${error.message}`, error);
console.error(`${tag} Third-party API failure: ${reason}`);
console.warn(`${tag} Version conflict when setting COMPLETED`);
console.warn(`${tag} age is missing, defaulting to 'unknown'`);
console.error('[AnalysisProcessor] DB connection failed', error);  // 包含完整 error 对象
```

改进要点：
- 所有日志携带 `[jobId=... traceId=...]` 标签，可按 jobId 或 traceId 搜索
- 错误日志使用 `console.error` 并附带完整 error 对象（含 stack trace）
- 警告日志使用 `console.warn` 区分严重程度
- 脏数据字段处理的警告包含具体字段名和值

### 4. Trace ID 透传

在 API 创建 job 时生成 traceId，贯穿整个处理链路：

```
API (createAnalysis)
  │  生成 traceId = uuid()
  │  写入 event.traceId
  ▼
MessageQueue (publishEvent)
  │  日志: Published event | jobId=xxx traceId=xxx
  ▼
QueuePoller (dequeue)
  │  日志: [jobId=xxx traceId=xxx] Dequeued message
  ▼
AnalysisProcessor (process)
  │  日志: [jobId=xxx traceId=xxx] Processing started
  │  日志: [jobId=xxx traceId=xxx] age is missing, defaulting to 'unknown'
  │  日志: [jobId=xxx traceId=xxx] Processing completed successfully
  ▼
全链路可追踪
```

排查问题时，只需用 traceId 搜索日志即可看到一个请求的完整生命周期。

## 测试脚本

测试脚本位于 `scripts/test-part3-observability.ts`，包含 6 个测试：

| 测试 | 验证内容 |
|------|----------|
| Test 1 | Zod 正确通过干净数据 |
| Test 2 | Zod 正确拒绝 3 种不同类型的脏数据 |
| Test 3 | Normalize 管道将可修复的字符串正确转换为数字/数组 |
| Test 4 | 完整 chaos 文件处理：5 条通过 + 7 条拒绝 = 12 条 |
| Test 5 | Worker 连续处理 10 个 job（随机脏数据场景），0 次崩溃 |
| Test 6 | traceId 在 processor 日志中正确出现 |

运行方式：`npx tsx scripts/test-part3-observability.ts`

## 验收结果

### 测试套件输出

```
=== Part 3: Observability & Fault Tolerance Test ===

Test 1: Zod validates clean records
  PASS: Clean record passes validation

Test 2: Zod rejects dirty data with error details
  PASS: All dirty records correctly rejected

Test 3: Normalize pipeline coerces fixable dirty data
  PASS: Fixable data normalized and passes validation

Test 4: Full chaos-data-samples.json processing
  PASS: 5 valid + 7 invalid = 12 total records

Test 5: Worker processor handles all dirty API scenarios without crashing
  [多条结构化日志输出，包含 jobId 和 traceId]
  [脏数据场景自动降级: age is missing, defaulting to 'unknown']
  PASS: 10/10 runs completed without crash (dirty data handled gracefully)

Test 6: traceId is present in event and processor output
  PASS: traceId=ae04e4cd-... found in processor output

--- Results: 6 passed, 0 failed ---
```

### pnpm run process:chaos 输出

```bash
$ pnpm run process:chaos

[ChaosProcessor] Loaded 12 records

  SKIP record-003: age: expected number, received null; email: Invalid email address
  SKIP record-004: gender: expected string, received undefined; tags: expected >=1 items; engagementScore: expected number, received null
  SKIP record-005: age: expected number, received string
  SKIP record-007: age: expected >=0; engagementScore: expected <=1
  SKIP record-008: age: expected number, received undefined
  SKIP record-009: gender: null; country: null; city: null; tags: null; engagementScore: null; email: null
  SKIP record-012: engagementScore: expected number, received string

Processed: 5 records
Skipped (validation failed): 7 records
Failed records saved to: failed-records/batch-1774230619001.json
```
