# Design — per-endpoint throttle buckets

## Architecture

单文件 IIFE 内复用现有 `createRateLimiter(windowMs, max)` 工厂，将 1 个全局桶拆为 3 个页面级实例：

- `searchLimiter`：`searchProfile` 专用，默认 `10s / 15`，面板可调（`wbl-rate-search`，clamp 1..15）。
- `timelineLimiter`：`mymblog` 专用，默认 `10s / 8`，面板可调（`wbl-rate-timeline`，clamp 1..15）。
- `writeLimiter`：`modifyVisible` + `requestDestroy`（含 `destroyStatus` / `destroyQuickRepost`）共用，固定 `10s / 10`，不暴露 UI。

删除原 `rateLimiter` 单例（或保留为兼容别名并停止使用，避免残留调用点误接）。所有调用点仍在 `fetch()` 前第一行 `await <bucket>.acquire(signal)`。

## Data flow & contracts

- `fetchSearchProfilePage({uid,starttime,endtime,page}, signal)` → `searchLimiter.acquire(signal)`，其余不变（含 403/414/429/RISK 分类）。
- `fetchBlogPage({uid,page,sinceId}, signal)` → `timelineLimiter.acquire(signal)` + 页间最小间隔：
  - `MYMBLOG_MIN_GAP_MS = 900`（每次成功 acquire 后、可中断 `sleep`，Abort 透传）；
  - 深页加压：`page >= MYMBLOG_DEEP_PAGE (300)` 时追加 `MYMBLOG_DEEP_EXTRA_MS = 600`。
  - 并发语义不变：`mymblog` 始终串行，`searchProfile` 波次并发仍 1~3。
- `modifyVisible` → `writeLimiter.acquire(signal)`；`requestDestroy` → `writeLimiter.acquire(signal)`（两个业务封装保持分离的成功语义：普通删除允许缺 `ok`，快转取消要求 `ok > 0`）。
- `mymblog` 补扫 RISK 退避（`runApiModeSearchProfile` 内兜底循环 + `runApiMode` 的 `fetchBlogPage` RISK 分支统一）：
  - 等待序列 `PAGE_RISK_WAITS_MS = [30000, 60000, 120000]` + `±20%` 抖动（`randomDelayMs` 复用思想，不引入新随机源语义）；
  - `MAX_PAGE_RETRY = 3` 不变；耗尽后 `break` 并标记 `stats.incomplete = true; stats.resumeMpage = mpage`，返回部分 `stats`（不抛空），`doPreview` 将其存入 `state.lastPreview` 并日志 `⚠ 补扫在第 X 页被限流中断，已保留部分预览（N 条），稍后可重跑继续`。
- UI：面板限速区由 1 个数字输入变为 2 个：
  - `wbl-rate-search` 默认 15；`wbl-rate-timeline` 默认 8；
  - `readRuntimeCfg()` 分别 clamp + `setMax`，`logRuntimeCfg()` 打印两桶；
  - hint 文案更新：搜索桶用于 `searchProfile` 页波次，时间线桶用于 `mymblog`（最近 N / mid 范围 / 补扫），写桶固定 10/10s。
- 版本：`// @version 0.8.3 → 0.8.4` + `BUILD_PANEL_HTML` 内 `<small>v0.8.4</small>` 同步。

## Compatibility & migration

- 无持久化状态（内存 + 面板输入），无迁移；旧面板输入 `els.delay` 改名，需同步更新所有引用点（`readRuntimeCfg` 唯一写点 + HTML id）。
- `runApiMode()`（最近 N / mid 范围直走 `mymblog`）自动享受 timeline 桶 + 退避，无需改筛选语义。
- RUM 抑制、Abort/Stop、在途收尾、`sameFilterCfg` 预览复用、confirm 二次确认均不改。

## Trade-offs

- 3 桶 vs 单桶全局上限：3 桶实现简单、定位清晰，代价是突发总和理论可达 33/10s；接受理由：三类请求服务端风控维度不同（读索引 vs 全量时间线 vs 写），实测瓶颈在 `mymblog` 单端点密度而非总和；面板默认值保守（15+8+10 中同时打满的场景不存在：预览期只有读，执行期只有写）。
- 不做按时段自动调速：夜间阈值开放无公开契约，时区/启发式切换脆弱；用保守默认 + 渐进退避 + 断点保留覆盖。
- 不暴露写桶 UI：`modifyVisible` 风控最敏感，固定保守值避免用户误调大；如后续实测允许再放开。

## Operational / rollback

- 回滚：单文件 `git checkout -- scripts/weibo-batch-locker.user.js` 即回退；无数据迁移、无后端。
- 观测：Network 按 `mymblog` / `searchProfile` / `modifyVisible` 过滤对比间隔；Console 以 `[wbl]` 为前缀；限流事件追加到 `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md`（日期 + 来源 + 结论）。
