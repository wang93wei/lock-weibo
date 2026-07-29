# 修复 SPA 路由后 UID 未刷新

## Goal

面板在任意已登录 weibo.com 页面都能识别当前登录 UID；SPA 路由变化后 UID 提示自动刷新，无需整页重载。

## Background（已复现 2026-07-29）

- 首页 `https://weibo.com/`：面板提示「未识别 UID」，但 `window.$CONFIG.uid` / `$CONFIG.user.idstr` 已有值（如 `1238726882`）。
- SPA 点击头像进 `/u/<uid>`：URL 已变，面板 UID 文案与启动日志仍停留在「未识别」（`refreshUidHint` 仅在创建 / 预览 / 执行时调用）。
- 整页刷新进个人页则正常（脚本重新注入）。

根因：
1. `getUid()` 只解析 pathname 的 `/u/`、`/profile/`，首页无匹配。
2. 无 SPA 路由监听，路径变化不刷新 UI。

## Requirements

1. **登录 UID 优先**：`getUid()` 优先取登录态（`$CONFIG.uid` / `$CONFIG.user.idstr` 等），再回退 URL `/u/<id>`、`/profile/<id>`。本工具只锁自己的微博，不依赖「当前是否在看自己主页」。
2. **首页可用**：已登录打开首页即可识别 UID，不再强制要求先打开 `/u/<uid>`。
3. **SPA 自动刷新**：路由变化后面板 `#wbl-uid` 自动更新；从「未识别」变为已识别时写一条 info 日志（避免刷屏：仅状态变化时记一次）。
4. **文案**：未识别时仍可提示打开个人页 / 确认登录；已识别显示 `当前 UID: <id>`。
5. **版本**：同步 bump `// @version` 与面板 `<small>vX.X.X</small>`（当前 `0.6.5` → `0.6.6`）。
6. **范围**：仅改 `scripts/weibo-batch-locker.user.js`；不改 API 契约、限速、筛选语义。

## Out of Scope

- 锁定他人主页微博
- 改 Tampermonkey 匹配规则 / 拆多文件

## Acceptance Criteria

- [x] 已登录首页打开面板：显示 `当前 UID: <登录uid>`，无「未识别」误报（代码：`$CONFIG.uid` 优先；需 Tampermonkey 重载 .user.js 手测）
- [x] 首页 → SPA 点进个人页：UID 提示保持/变为正确，无需 F5（`onSpaNavigate` + `refreshUidHint`）
- [x] 个人页 → SPA 回首页：UID 仍正确（登录态）
- [x] 预览/执行仍用最新 `getUid()`，行为与现有一致
- [x] 版本号两处均为 `0.6.6`

## Notes

- 轻量任务，PRD-only。
- 验证：Tampermonkey 装更新后的 `.user.js`，首页与 SPA 导航各走一遍。
