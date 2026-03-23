# 第四部分：系统设计与权衡 - 你的回答

## 1. 架构升级方案

### 架构图 (ASCII)

```
                        ┌─────────────────────────────┐
                        │         API Gateway          │
                        └──────────┬──────────────────┘
                                   │
                                   ▼
                        ┌─────────────────────────────┐
                        │   LegacyApp (NestJS ECS)     │
                        │   - 只创建 PENDING job       │
                        │   - 生成 traceId             │
                        │   - 发布事件到 SQS           │
                        └─────┬──────────┬────────────┘
                              │          │
                    写 PENDING │          │ 发布事件
                              ▼          ▼
                     ┌──────────┐  ┌──────────┐
                     │ MongoDB  │  │  AWS SQS  │
                     │ Atlas    │  │  (FIFO)   │
                     └──────────┘  └────┬─────┘
                           ▲            │
                           │            ▼
                           │   ┌─────────────────────────────┐
                           │   │  WorkerService (ECS/Fargate) │
                           │   │  - 乐观锁写入                │
                           │   │  - Zod 校验第三方数据         │
                           │   │  - 结构化日志 → CloudWatch    │
                           └───┤  - 失败 → DLQ                │
                               └─────────────────────────────┘
                                          │
                                     失败消息
                                          ▼
                               ┌─────────────────┐
                               │  SQS DLQ        │
                               │  → Lambda 告警   │
                               └─────────────────┘
```

### 核心改动点

1. **替换文件队列为 AWS SQS FIFO**：保证消息顺序性和 exactly-once 语义，消除文件系统并发问题
2. **引入 DLQ（Dead Letter Queue）**：处理失败的消息自动进入 DLQ，配合 Lambda 发送告警
3. **MongoDB Atlas 替代本地 MongoDB**：自动扩缩、备份、监控
4. **结构化日志 → CloudWatch Logs Insights**：所有日志输出 JSON 格式，支持按 traceId / jobId 查询
5. **ECS/Fargate 部署**：Worker 可按 SQS 队列深度自动扩缩容

## 2. 对 CTO 建议的回应 (Rust 重写?)

**我不建议在 2 周内用 Rust 重写**。理由：

1. **问题根因不是语言性能**：当前的 bug 是架构问题（双写竞态、缺乏校验、日志缺失），换 Rust 不会修复这些问题。

2. **Node.js 的性能足够**：
   - 当前场景是 I/O 密集型（HTTP 请求、DB 读写、队列轮询），Node.js 的异步模型天然适合
   - 如有 CPU 密集计算，可用 `worker_threads` 或将计算部分抽出为 Rust WASM 模块

3. **团队风险**：如果团队主要技能是 TypeScript/Node.js，Rust 重写意味着学习曲线、招聘难度、维护成本三重风险

4. **务实方案**：
   - 在 Node.js 中修复架构问题（本次已完成）
   - 如果后续真的有性能瓶颈，可以渐进式引入 Rust：用 napi-rs 将热点路径（如数据转换）编译为 native addon

## 3. 2 周冲刺中的"妥协" (Trade-offs)

| 保留 | 放弃 | 原因 |
|------|------|------|
| Single Writer + 乐观锁 | 完整的分布式事务 / Saga | 乐观锁已解决竞态，Saga 过于复杂 |
| Zod 运行时校验 | 100% 覆盖的单元测试 | 先保证运行时不崩溃，测试后续补 |
| traceId 全链路透传 | 完整的 OpenTelemetry 集成 | traceId + 结构化日志已可排查，OTel 后续接入 |
| 基础 DLQ + 告警 | 完善的重试策略（指数退避、断路器） | 先确保失败消息不丢，重试逻辑迭代增加 |
| Docker Compose 本地开发 | 完美的 CI/CD pipeline | 本地能跑是第一步，CI/CD 第二个 Sprint |
| 事件捕获 + Replay 脚本 | 完整的 E2E 测试套件 | Replay 脚本已能本地调试，E2E 测试成本高 |

核心原则：**先止血（修复根本问题），再造血（完善基础设施）**。

## 4. 大规模错误的调试策略

面对 5 万条错误日志的系统设计：

### 不让系统崩溃

1. **批处理隔离**：单条记录失败不影响整批，失败记录移入 DLQ 而非重试阻塞
2. **背压控制**：SQS 消费者通过 `maxNumberOfMessages` 和 `visibilityTimeout` 控制处理速率
3. **熔断机制**：如果连续 N 次调用第三方 API 失败，暂停消费队列，等待恢复

### 排查问题

1. **结构化日志分层**：
   - `ERROR` 级别：只记录真正的失败（第三方 API 错误、数据库写入失败）
   - `WARN` 级别：记录可恢复的问题（脏数据降级、乐观锁冲突）
   - 每条日志必须包含 `jobId`、`traceId`、`errorType`

2. **错误聚合**：
   - 按 `errorType` 聚合，快速发现是 "第三方 API 格式变了" 还是 "数据库超时"
   - CloudWatch Logs Insights 查询示例：
     ```
     fields @timestamp, jobId, traceId, errorType, @message
     | filter level = "ERROR"
     | stats count(*) by errorType
     | sort count desc
     ```

3. **失败记录持久化**：
   - 所有失败记录保存原始数据 + 失败原因 + 时间戳
   - 支持修复后批量重放（使用 replay 脚本）

4. **告警分级**：
   - DLQ 消息数 > 100：P2 告警
   - DLQ 消息数 > 1000：P1 告警
   - 错误率 > 50%：P0 告警，自动暂停消费
