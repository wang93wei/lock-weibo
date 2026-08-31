# Technical Design

## Scope and Boundary

只修改单一运行时文件 `scripts/weibo-batch-locker.user.js`。不改变 API 路径、请求编码、筛选语义或 UI 主结构；新增能力是“有界并发 + 与 Python 对齐的默认请求窗口”。

## Configuration

在 `CONFIG` 中集中维护：

- `CONCURRENCY: 3`：扫描页波次和锁定 worker 池的默认并发数。
- `RATE_MAX: 15`：任意 `RATE_WINDOW_MS=10000` 内最多放行 15 个真实请求。
- `SEARCH_PAGES_PER_WINDOW: 30`：单个 `endtime` 窗口最多探测 30 页，覆盖现网单查询约 21 页/1000 条深度上限并留裕量。
- 保留现有 RISK 等待、重试和分页安全上限。

面板新增并发输入（1~3），限速输入范围改为 1~15。非法值在开始操作前 clamp 并回写输入框；运行中输入均 disabled，不允许动态改变本次任务。两个值在每次预览/执行开始时读取；`rateLimiter.setMax()` 更新全局窗口额度，并发数作为显式参数传入扫描与执行函数，避免隐藏的全局可变行为。

15 次/10 秒是用户基于 Python 实测明确接受的默认值，不覆盖 userscript 既有 3 次/10 秒风控证据。实现日志和交付结论必须把它标为“待 Tampermonkey 登录态验证”；命中 RISK 时仍暂停 30 秒，用户可在面板把额度调低。

## Request Matrix

| Filter / action | Endpoint | Concurrency |
|---|---|---|
| 时间预设、日期范围 | `GET searchProfile` | 每波最多 N 页 |
| 最近 N、mid 范围 | `GET mymblog` | 串行 |
| searchProfile 深历史补扫 | `GET mymblog` | 串行 |
| 锁定 | `POST modifyVisible` | 最多 N 个 worker |
| PERM 删除兜底 | `POST destroy` | 占用所属锁定 worker；仍受全局限流 |

四条路径每次调用仍在 `fetch()` 前独立执行 `await rateLimiter.acquire(signal)`，因此扫描、锁定、删除共用同一滑动窗口预算。

## SearchProfile Page-Wave Flow

1. `fetchSearchProfilePage` 接收显式 `page`，不再固定为 1。
2. 每个 `curEnd` 形成一轮；轮内按 `concurrency` 切分页波次，例如 `1..3`、`4..6`。
3. 每页保留独立的分页重试与 RISK 30 秒等待。波次使用 `Promise.allSettled`（或等价的全部收尾机制）等待全部完成；AUTH 在波次收尾后抛出，其他页失败记录后结束本次扫描，避免静默漏页。
4. 按页码顺序处理返回列表，维护跨页/跨轮 `seenMids`、本轮新条目数，以及本轮**所有原始返回项**的最旧时间。游标不得只看新 mid，否则边界重复项可能造成同秒尾部漏扫。
5. 首个多页波次比较非空页的 id 序列：page 2 与 page 1 完全相同时判定服务端忽略 page，当前轮只消费一次该序列，后续轮次固定只请求 page=1；序列不同则继续有界页波次。
6. page 生效时，整波全空或无新 mid 就结束本轮；到达 `SEARCH_PAGES_PER_WINDOW` 后也结束本轮。只要本轮有新数据，就以本轮所有原始返回项的最旧 epoch 含边界推进 `curEnd`。
7. page 被忽略时，每个时间窗口最多承担首轮探测的有限重复请求；探测后自动回退单页游标，仍以 `endtime` 推进。
8. 不使用 `data.total`、短页或 page 越界作为全量终止条件；没有覆盖到 `starttime` 时仍进入串行 `mymblog` 补扫。

## Lock Worker Pool

抽取一个仅用于有限任务消费的 worker-pool helper：

- 共享一个同步递增索引，启动 `min(concurrency, items.length)` 个 worker。
- worker 每次只领取一条待锁微博，并完整执行该条的重试、PERM/destroy、日志和计数后再领取下一条。
- 只有 AUTH（包括 destroy AUTH）属于池级 fatal error，并停止派发新任务；RISK 重试耗尽、普通 API 失败、PERM 和 destroy 非 AUTH 失败只结束当前项并继续派工。
- worker 顶层使用 `Promise.allSettled`（或等价机制）等待所有已启动 Promise settle 后，才向 UI 抛出 AUTH/Abort，避免面板恢复 idle 后仍有后台修改。
- 外部 `AbortSignal` 继续传给限流等待、退避等待和 fetch；用户停止时所有 worker 尽快退出。
- Abort 不能撤销服务端已经接收的修改；UI 保持现有“已完成的不会回滚”语义。
- `stats` 更新发生在同步代码段内；每次更新向 UI 传快照。并发完成日志可乱序，成功/失败/删除/跳过总数必须满足对账。

## Compatibility and Safety

- 最近 N/mid 的 `runApiMode` 扫描路径不并发改造；真实执行仍统一走并发后的 `lockByIds`。
- 预览 hits、`item.isPrivate` 回写、筛选一致性、UID/XSRF 校验、SPA hint 和删除确认保持现状。
- canonical id 仍为 `idstr`；接口 headers/body 保持现有已验证实现。
- 版本升级为 0.8.0，两处同步。

## RUM Suppression During Operations

微博页面当前加载 Elastic APM RUM 5.17，并以 `window.elasticApm.addFilter` 提供发送前 payload filter。userscript 在模块级维护抑制状态：活跃操作计数、宽限截止时间，以及已注册 agent 的 `WeakSet`。每个 agent 仅注册一次 filter；当活跃计数大于 0 或当前时间未超过宽限截止时返回 `false`，其余时间原样返回 payload。

预览和真实执行在进入网络阶段后获取一次 release 函数，并在既有最外层 `finally` 中调用。release 同步减少活跃计数，并把宽限截止推进到至少“当前时间 + 3 秒”，不启动后台 Promise、不依赖业务 AbortSignal，因此 AUTH、Abort、校验外异常都不会留下永久抑制。若两次操作在宽限期内衔接，新操作通过活跃计数继续抑制，旧 release 不会提前恢复。

不调用运行时未文档化的私有字段，不使用 `elasticApm.config({active:false})`，不 monkey-patch `fetch` / `XMLHttpRequest`。filter 仅影响发往 RUM intake 的监控 payload；四个业务 API、统一限流器和错误语义不变。3 秒宽限匹配当前页面约 2 秒的常见 RUM 发送节奏，但这是 best-effort，不承诺阻止宽限后才排队发送的历史 payload。

## Validation

- 静态：`node --check scripts/weibo-batch-locker.user.js`。
- 搜索核对：只有四个 `fetch`，每个调用点前仍有 `rateLimiter.acquire(signal)`；无对完整 hits 的无界 `Promise.all`。
- 代码审查：page 漂移回退、游标取全部原始返回项最旧时间、页波次/worker 最大值、AUTH/Abort 全部收尾、统计对账、版本同步。
- 受控 harness：mock `elasticApm.addFilter`，验证操作期 falsy、release 后 3 秒内仍 falsy、宽限后恢复 payload、filter once、缺失 APM no-op、重叠操作不早退。
- 人工：Tampermonkey 登录态分别验证四种筛选的预览；用少量命中验证并发执行、停止与可选 PERM 行为。未执行时明确标注未做真实微博验证。

## Rollback

改动集中在 CONFIG/UI、searchProfile 扫描和 `lockByIds`。若并发出现异常，可先把面板并发调为 1；代码回滚时恢复 page=1 游标扫描和串行 `for` 执行，不触碰 API 契约及预览数据结构。
