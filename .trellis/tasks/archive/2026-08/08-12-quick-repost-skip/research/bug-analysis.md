# Bug Analysis: 快转被当作本人微博并重复重试

### 1. Root Cause Category

- **Category**: E - Implicit Assumption（同时涉及 B - Cross-Layer Contract）
- **Specific Cause**: 脚本假设 `mymblog` 个人时间线中的顶层条目都归当前用户所有。实际快转条目直接返回原作者微博，并通过 `ori_uid` / `ori_mid` 和“取消快转”菜单表达当前账号的快转关系。API 层又在 `!res.ok` 时丢弃响应正文，使 HTTP 400 的确定性所有权拒绝被归入通用指数退避。

### 2. Why Fixes Failed

1. 初始日志只显示 `modifyVisible HTTP 400`：响应正文未读取，无法区分参数错误、所有权拒绝与临时服务错误。
2. 通用重试覆盖所有非 AUTH/RISK 错误：缓解了瞬态错误，却把不可恢复的 4xx 业务拒绝也重复执行。

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|----------|-----------|-----------------|--------|
| P0 | Architecture | 预览项显式保存 `skipReason`，所有待锁计数统一通过 `isPreviewLockable` | DONE |
| P0 | Runtime | 非 2xx 先解析正文；`not your own weibo` 分类为不可重试跳过 | DONE |
| P0 | Contract | 用官方 `mblog_menus_cancel_quick_forward` 主判快转，并以所有权字段组合兜底 | DONE |
| P1 | Documentation | 更新 API 实测记录与第三方 API 验证指南 | DONE |
| P1 | Regression | 覆盖快转 0 请求、字段漂移 1 请求后跳过、普通转发不误判 | DONE（一次性 Node VM 检查） |

### 4. Systematic Expansion

- **Similar Issues**: 收藏、推荐、置顶或其他派生 feed 项也可能出现在个人页，但不代表当前账号拥有底层实体。
- **Design Improvement**: 列表原始字段只在统一判定函数中转换为可执行预览项；UI、确认框和执行器不再分别推断可锁定性。
- **Process Improvement**: 验证私有 API 时必须同时抓成功与失败响应，并检查官方 UI 是否提供对应操作。

### 5. Knowledge Capture

- [x] 更新 `weibo-api-notes.md`，记录 2026-08-12 快转形态与失败响应。
- [x] 更新第三方 API 验证指南，加入所有权/能力与 4xx 重试分类检查。
- [x] 将执行链回归结果保存在当前任务记录中。
