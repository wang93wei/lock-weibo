# mymblog与searchProfile分桶限流

## Goal

解决深历史扫描中 `mymblog` 高频分页触发微博限流（HTTP 414 /“频次过快”，约 400 页附近失败）的问题，同时保持 `searchProfile` 时间索引扫描的高效；夜间限速更开放、白天更严的服务端动态阈值下，默认配置不再互相挤占。

用户价值：3 个月回溯等时间预设预览不再在 `mymblog` 补扫阶段被限流中断；`searchProfile` 不因迁就 `mymblog` 而被拖慢。

## Background

- 单一全局滑动窗口限流器覆盖全部四个业务 fetch：`createRateLimiter(CONFIG.RATE_WINDOW_MS=10000, CONFIG.RATE_MAX=15)`，`scripts/weibo-batch-locker.user.js:408-445`；每次 `fetchBlogPage / fetchSearchProfilePage / modifyVisible / requestDestroy` 前 `await rateLimiter.acquire(signal)`（`:590,629,651,711`）。
- UI 单一限速输入“每 10 秒最多 N 次请求”，`clamp 1..15`，`readRuntimeCfg()` 直接 `rateLimiter.setMax(rateMax)`（`:1786-1787`）；并发上限 1~3，`mymblog` 始终串行（`:2195`，`runApiMode` 分页循环 `:1068` 注释）。
- 故障现场（用户截图 Image 1）：时间预设“3 个月前”，并发 3，15/10s；右侧 Network 显示 `mymblog?page=384~402` 密集失败，日志 `mymblog 第 402 页被限流，暂停 30s 后重试 (1/3)...(2/3)... HTTP 414，结束补扫`；已扫描 7780，已跳过 7784，待办 96。
- `searchProfile` 走服务端时间过滤，请求量小，当前阈值下不触发限流；`mymblog` 全量时间线分页（~20 条/页，深历史需数百页）是限流重灾区。`runApiModeSearchProfile` 索引见底时自动切 `mymblog` 补扫（`:1356-1421`）。
- 当前 `mymblog` 页级 RISK 重试：`MAX_PAGE_RETRY=3`，每次 `RATE_LIMITED_WAIT_MS=30000`，耗尽即终止整个补扫（`:1380-1386`），进度不保留续扫。
- 实时页（Chrome MCP page 2）另见执行阶段 `modifyVisible` 大量 HTTP 400 PERM（“暂不支持变更可见范围”），与限流无关但共用同一桶，会挤占读请求额度。

## Requirements

- R1：将读/写限流按端点组拆桶：`searchProfile` 宽松桶 / `mymblog` 严格桶 / 写操作（`modifyVisible`/`destroy`）独立桶，互不挤占。
- R2：`mymblog` 桶默认显著慢于 `searchProfile`（含页间最小间隔与深页加压），400+ 页不再以 15/10s 速度直冲 414。
- R3：`mymblog` RISK 退避改为渐进式（30s→60s→120s + 抖动），耗尽后保留已扫部分进度并提示断点页码，而非丢弃整个预览。
- R4：UI 拆为双输入（搜索限速 / 时间线限速，写桶固定保守不暴露），限速表达与实现一致；版本号双处同步（header + 面板）。
- R5：不引入第二套模块/依赖，保持单文件 IIFE + `createRateLimiter` 复用；所有 fetch 仍 `credentials:include + apiHeaders()`，仍可 Abort/Stop；在途收尾语义不变。

## Acceptance Criteria

- [ ] 时间预设 3 个月 dry-run：`searchProfile` 阶段速度不低于现状，`mymblog` 补扫阶段不再出现连续 414 导致的中断（或中断后保留部分预览并提示断点可重跑）。
- [ ] 并发 1 与 3 分别验证 Stop/AUTH：在途收尾后回 idle，已完成不回滚。
- [ ] `node --check scripts/weibo-batch-locker.user.js` 通过；`git diff --check` 无空白错误。
- [ ] 真实页面验证（登录态，低额度先行）：Network 中 `mymblog` 间隔明显拉开，`searchProfile` 波次不受拖累；Console 无限流刷屏。

## Out of Scope

- 不做基于时间的“夜间加速/白天减速”自动切换（时区脆弱，服务端阈值未公开）。
- 不改变筛选语义（最近 N 计数、日期边界、快转识别 `ori_mid` 规则）。
- 不改变删除兜底默认关闭与二次确认安全边界。

## Key Decisions

- D1：3 桶独立 — `searchProfile` 宽松桶 / `mymblog` 严格桶 / 写操作独立桶（用户已确认）。
- D2：UI 双输入 — 搜索默认 15/10s 可调 + 时间线默认 8/10s 可调；写桶固定 10/10s 不暴露（用户已确认）。

## Technical Notes

- 复用 `createRateLimiter(windowMs, max)` 工厂，不新增依赖；页间隙用可中断 `sleep(ms, signal)` 实现，保留 Abort 语义。
- 约束来源：`.trellis/spec/frontend/quality-guidelines.md`（并发/分页/取消/RUM/版本同步）、`AGENTS.md`（单文件、限流器、Abort、不转 Number、confirm 安全边界）。
- 微博 AJAX 为未公开内部接口，改动前后需按指南用登录态 DevTools Network 一手复核，结论追加到 `weibo-api-notes.md`。
