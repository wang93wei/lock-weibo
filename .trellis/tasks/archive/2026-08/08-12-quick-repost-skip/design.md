# 设计：可选批量取消快转

## UI 与状态

- 筛选区增加 `cancelQuickReposts` 复选项，默认 `false`，并纳入 `filterCfg` 与 `sameFilterCfg` 比较。
- 预览项规范化为 `action: "lock" | "cancelQuickRepost" | "skip"`；取消项另存 `actionId=ori_mid`，展示仍使用原微博 `mid`。
- 计数从预览项当前状态派生：`pendingLock`、`pendingCancel`；成功后将 `completed=true`，避免重复执行。
- 保留总成功/跳过/失败卡片，同时在 stats 中维护 `lockedSuccess` 与 `cancelledSuccess` 供分项总结。

## API 契约

- 锁定保持 `POST /ajax/statuses/modifyVisible` 表单 `ids=<mid>&visible=1`。
- 取消快转新增 `POST /ajax/statuses/destroy`，JSON body `{ id: String(ori_mid) }`，使用官方前端当前编码方式。
- 两类 API 共用 `apiHeaders`、`credentials:"include"`、全局 `rateLimiter.acquire(signal)` 与统一响应正文提取。
- `/destroy` 的 4xx/业务拒绝不可重试；网络和 5xx 最多按 `MAX_RETRY` 指数退避；AUTH/RISK 沿用既有特殊分支。

## 执行数据流

1. 扫描按既有筛选语义产生预览项。
2. 快转关闭时生成 `skip`；开启且有 `ori_mid` 时生成 `cancelQuickRepost`；缺 ID 时生成带原因的 `skip`。
3. 确认后将未完成 `lock` 与 `cancelQuickRepost` 分组。
4. 先逐条锁定，再逐条取消；每次成功立即修改同一预览快照并刷新计数。
5. Abort、AUTH 或页面关闭终止后续动作，已完成项保持完成态。

## 兼容与风险

- 普通转发通过顶层所有者/`retweeted_status` 与快转区分，仍生成 `lock`。
- 复选项默认关闭，升级后不会自动删除任何快转关系。
- 不对缺失 `ori_mid` 做降级猜测，避免误删原微博或其他记录。
- 版本从当前未提交的 `0.6.8` 统一提升为 `0.6.9`。
