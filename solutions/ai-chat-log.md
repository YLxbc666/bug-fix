# AI 协作记录 (AI Chat Log)

> 本文档记录了在解决 Senior Backend Challenge 过程中与 AI 助手的协作过程、关键决策和思路。

## 使用的 AI 工具

- **AI Assistant**: Claude (Cursor IDE 集成)
- **交互模式**: Agent Mode — 代码阅读、分析、编辑、终端操作

---

## Part 1: Capture & Replay 工具

### Prompt 思路

1. 要求 AI 分析 `message-queue.service.ts` 和 `analysis.processor.ts` 的现有代码结构
2. 讨论事件捕获的最佳插入点：在 `publishEvent()` 中自动保存 JSON 快照
3. 实现 `scripts/replay-event.ts`，直接调用 `AnalysisProcessor.process()` 绕过队列

### 关键决策

- 选择在 MQ publish 时捕获（而非 API 层），确保捕获的 payload 与 Worker 实际接收的一致
- Replay 脚本复用 Worker 的 Processor，保证执行路径一致

---

## Part 2: 架构治理 — 双写问题

### Prompt 思路

1. 要求 AI 识别 `analysis.service.ts` 中的双写竞态问题：API 层 `delayedUpdate()` 与 Worker 同时写入同一条记录
2. 讨论解决方案：移除 API 层的异步写入，Worker 独占写入权
3. 引入乐观锁 (`version` 字段) 防止并发覆盖

### 关键决策

- 采用 **Single Writer** 原则：API 只负责创建 Job（PENDING 状态），不做任何后续更新
- 使用 MongoDB `$inc: { version: 1 }` 配合 `version` 条件写入实现乐观锁
- 权衡过后没有引入分布式锁，因为单 Worker 场景下乐观锁已足够

---

## Part 3: 数据容错 — 脏数据防崩溃

### Prompt 思路

1. 分析 `analysis.processor.ts` 中缺少输入验证的问题
2. 讨论 Zod schema 验证 vs 手动校验的优劣
3. 实现结构化日志和 failed-records 持久化

### 关键决策

- 采用 **Zod** 进行运行时 schema 验证，提供清晰的错误信息
- 验证失败的记录写入 `failed-records/` 目录，而非直接丢弃
- 处理逻辑用 try-catch 包裹，单条失败不影响其他记录

---

## Part 4: Audience Bug 调试

### Prompt 思路

1. 要求 AI 追踪完整调用链 `run-audience-test.ts → audience.service.ts → facade-audience.service.ts → mock-audience-api.ts`
2. 发现 `mock-audience-api.ts` 对 `mediaId=12345` 返回不同的 JSON 结构（`audience_data.demographics` vs `data.audience`）
3. 定位到 `facade-audience.service.ts` 第 81 行只处理了新格式

### AI 分析过程

```
Q: 为什么 mediaId=12345 返回 null？
A: mock-audience-api.ts 对 12345 返回 legacy 格式:
   { status: "success", audience_data: { demographics: { gender: [...] } } }
   但 facade-audience.service.ts 只做了:
   const extracted = audienceData.data?.audience;
   对 legacy 格式，audienceData.data 是 undefined，所以 extracted 为 undefined。

Q: 怎么修复？
A: 添加类型守卫区分两种格式，对 legacy 格式从 audience_data.demographics 提取数据，
   归一化为与新格式相同的 { gender, age, geography } 结构。
```

### 关键决策

- 定义 `NewFormatResponse` 和 `LegacyFormatResponse` 两个 TypeScript 接口
- 用 `isNewFormat()` / `isLegacyFormat()` 类型守卫进行运行时判断
- 提取逻辑封装为纯函数 `extractAudienceData()`，便于单元测试
- 改善浏览器资源管理：用 `finally` 确保关闭，`batchGetAudience` 共享 browser context

### 修复验证

```bash
$ pnpm simulate:audience-bug
✅ Success: 5/4.5 requests
❌ Errors: 0
```

---

## Part 5: 系统设计与权衡

### Prompt 思路

1. 讨论 500 万条/2 小时的吞吐量需求
2. 评估 CTO 的 Rust 重写建议 vs Node.js 水平扩展
3. 设计监控和报错机制

### 关键决策

- 拒绝 Rust 重写（2 周 1 人不现实），选择 Node.js + 多 Worker 水平扩展
- 使用 S3 Event → SQS → 多 Worker 消费的架构
- 监控：采样错误日志 + 聚合统计，避免报警风暴

---

## Build 问题修复

### 问题

`apps/worker-service` 和 `apps/legacy-app` 的 `package.json` 中没有声明 `@senior-challenge/shared-types` 为 workspace 依赖，导致 `pnpm -r build` 报 `Cannot find module` 错误。

### 修复

在两个 app 的 `package.json` 中添加：

```json
"@senior-challenge/shared-types": "workspace:*"
```

然后 `pnpm install --no-frozen-lockfile` 重新生成 lockfile 并链接 workspace 包。

---

## 总结

AI 在本次挑战中主要扮演以下角色：

1. **代码阅读加速器**：快速跨文件追踪调用链，定位问题根因
2. **方案讨论伙伴**：评估不同修复方案的优劣（如乐观锁 vs 分布式锁）
3. **代码生成助手**：基于明确的设计决策生成实现代码
4. **测试脚本编写**：自动生成覆盖正常/异常场景的测试用例

关键原则：**人负责决策，AI 负责执行**。所有架构选择（Single Writer、Zod 验证、类型守卫等）都基于对业务场景的理解做出判断，AI 辅助实现。
