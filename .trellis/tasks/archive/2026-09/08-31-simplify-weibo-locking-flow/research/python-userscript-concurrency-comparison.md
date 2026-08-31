# Python 与 userscript 请求节奏对比

## Evidence

参考文件：`/Users/alanwang/git/chajia/自用/weibo.py`（2026-08-31 本地读取）。

- `CONCURRENCY=3`、`RATE_WINDOW_S=10`、`RATE_MAX=15`；所有 GET/POST 先调用同一 `throttle()`（40-68 行）。
- `searchProfile` 以每波 3 页执行 `asyncio.gather`，窗口内最多 30 页；跨窗口以含边界 `endtime` 推进并用 `seen` 去重（309-379 行）。
- 单页待锁微博通过 `asyncio.gather` 并发调用 `modifyVisible`（224-240 行）。
- `mymblog` 补扫明确逐页串行，页面内锁定仍并发（381-418 行）。
- Python 没有用户可中止、dry-run、二次确认和分类退避；userscript 必须保留这些安全能力。

当前 `scripts/weibo-batch-locker.user.js`：

- 全局 limiter 默认 3 次/10 秒，四个 API helper 均在 fetch 前 acquire。
- `runApiModeSearchProfile` 固定 page=1 并串行收缩 endtime。
- `runApiMode`、mymblog fallback 和 `lockByIds` 均为 `for + await` 串行。
- 执行复用预览 hits，不会重新扫描；该优化必须保留。

## User Decisions

- 所有四种筛选继续支持：最近 N、时间预设、日期范围、mid 范围。
- 默认并发数 3，默认滑动窗口额度 15 次/10 秒。
- 用户已接受 15 次/10 秒作为新默认；它只在 Python 环境实测，不能覆盖 userscript 曾以 3 次/10 秒规避 414/429 的既有证据，仍需 Tampermonkey 登录态验证。
- 按 Python 增加 `searchProfile` 页波次与锁定并发；`mymblog` 分页继续串行。
- 保留现有四个 endpoint 与安全 UI；不新增不可靠的 total 探测请求。

## Constraints

- API 契约、idstr、PERM、destroy JSON body、RISK/AUTH 分流均以既有一手 API 笔记为准。
- `searchProfile` page 行为会漂移，因此并发页波次不能替代含边界 endtime 游标和 `seenMids` 去重。
- 页波次需比较返回 id 序列；检测到 page 被忽略后，后续轮次退回 page=1，避免持续重复并发请求。
- 游标使用本轮所有原始返回项的最旧时间，而非仅最旧新 mid，保住同秒边界语义。
- 禁止用 `data.total`、短页或固定延迟控制扫描终止/风控。
