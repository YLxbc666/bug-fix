# 第四部分：Audience 数据格式兼容性 Bug 修复

## 问题分析

### 根因定位

通过追踪完整调用链 `run-audience-test.ts → audience.service.ts → facade-audience.service.ts → mock-audience-api.ts`，发现问题出在 `facade-audience.service.ts` 的数据提取逻辑。

**核心 Bug**：`facade-audience.service.ts` 第 81 行只处理了"新格式"的 API 响应：

```typescript
// 只处理了新格式 data.audience
const extracted = audienceData.data?.audience;
```

当第三方 API 返回**老格式** (`audience_data.demographics`) 时，`extracted` 为 `undefined`，导致返回 `null`。

### 两种 API 响应格式对比

**新格式**（大部分 mediaId）:
```json
{
  "status": "success",
  "data": {
    "audience": { "gender": [...], "age": [...], "geography": {...} }
  }
}
```

**老格式**（如 mediaId=12345）:
```json
{
  "status": "success",
  "audience_data": {
    "demographics": { "gender": [...] }
  }
}
```

## 修复方案

### 1. 定义 TypeScript 类型

为两种响应格式分别定义接口 `NewFormatResponse` 和 `LegacyFormatResponse`，并用联合类型 `AudienceApiResponse` 统一表示。

### 2. 添加类型守卫 (Type Guards)

```typescript
function isNewFormat(response: AudienceApiResponse): response is NewFormatResponse {
    return 'data' in response && response.data != null && 'audience' in response.data;
}

function isLegacyFormat(response: AudienceApiResponse): response is LegacyFormatResponse {
    return 'audience_data' in response && response.audience_data != null;
}
```

### 3. 统一提取函数

`extractAudienceData()` 根据类型守卫检测格式，将两种格式统一归一化为 `NormalizedAudienceData`：

- 新格式：直接取 `data.audience`
- 老格式：从 `audience_data.demographics` 映射到 `{ gender, age, geography }` 结构

### 4. 其他改进

- 使用 `finally` 块确保浏览器在异常时也能正确关闭（防止资源泄漏）
- `batchGetAudience` 现在共享单个 browser instance，减少不必要的浏览器启动开销
- 改善日志输出，明确标注检测到的格式类型
- 函数返回类型从 `Promise<any>` 改为 `Promise<NormalizedAudienceData | null>`

## 验证结果

运行 `pnpm simulate:audience-bug` 后输出：

```
✅ Success: 5/4.5 requests
❌ Errors: 0
```

所有 mediaId（包括之前失败的 12345）均成功返回数据。

## 测试

测试脚本 `scripts/test-part4-audience-bug.ts` 包含两部分：

- **Part A（单元测试）**: 直接测试 `extractAudienceData` 逻辑，覆盖新格式、老格式、未知格式、部分字段缺失等场景
- **Part B（端到端测试）**: 启动 Mock API + Playwright，验证完整调用链
