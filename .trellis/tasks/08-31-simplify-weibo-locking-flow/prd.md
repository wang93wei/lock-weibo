# 为微博批量锁增加有界并发

## Goal

参考 `/Users/alanwang/git/chajia/自用/weibo.py` 已由用户实测稳定的并发方式，为 `scripts/weibo-batch-locker.user.js` 增加可配置的有界并发，缩短扫描与批量设为“仅自己可见”的耗时，同时保留现有四种筛选、安全确认和风险控制。

## Background

- 用户观察到当前 v0.7.0 userscript 串行执行较重，并已实测 Python 参考版的并发方式可用。
- Python 参考版使用 `asyncio.gather`：`searchProfile` 每波并发 3 页、单页待锁微博并发修改；所有 GET/POST 共用 10 秒最多 15 次的滑动窗口限流。
- 当前 userscript 的四类 API 请求均经过同一滑动窗口限流器，但扫描、修改与删除全部为 `for + await` 串行，默认 10 秒最多 3 次。
- 用户确认默认采用 Python 参数：并发数 3、任意 10 秒最多 15 次请求。
- 用户接受将 userscript 从既有 3 次/10 秒提高到 15 次/10 秒的风险；该额度只有 Python 环境实测证据，尚未在 Tampermonkey 登录态验证，不得表述为 userscript 已验证安全。
- 用户确认保留截图中的全部筛选方式：最近 N 条、时间预设、日期范围、mid 范围。
- 当前 userscript 的四个接口路径继续保留：`searchProfile`、`mymblog`、`modifyVisible`、`destroy`。不新增 Python 的 `get_weibo_total` 额外请求，因为 `searchProfile.data.total` 在大窗口下不可信且不参与控制流。

## Requirements

### R1. 有界并发与统一限流

- 默认并发数为 3，面板允许在 1~3 内调整；设置为 1 时退化为串行。
- 默认滑动窗口额度改为任意 10 秒最多 15 次请求，面板允许在 1~15 内调低。
- `searchProfile`、`mymblog`、`modifyVisible`、`destroy` 的每次真实请求仍须先获取同一个全局 `rateLimiter` 令牌。
- 禁止对不受控长度的数据直接使用无界 `Promise.all`；并发必须由固定页波次或固定 worker 数约束。

### R2. 四种筛选保持可用

- 时间预设、日期范围继续走 `searchProfile`，改为页波次并发；跨深度仍使用含边界 `endtime` 游标和 `seenMids` 去重。
- 首波探测 `searchProfile.page` 是否仍生效；若多页返回相同 id 序列，则本次扫描后续轮次自动退回 page=1 的串行游标，避免服务端漂移后重复并发请求。
- 最近 N 条、mid 范围继续走 `mymblog`。
- `searchProfile` 索引未覆盖到下界时，继续使用 `mymblog` 补扫，避免深历史漏锁。
- `mymblog` 分页保持串行，因为该接口并发翻页尚无一手安全验证。

### R3. 并发执行保持原有错误语义

- 预览完成后继续复用 `lastPreview.hits`，执行阶段不得重新扫描。
- 待锁微博以固定 worker 池并发调用 `modifyVisible`。
- AUTH 终止后续派工；RISK 等待 30 秒后按现有上限重试；普通 API 错误指数退避；PERM 单条只请求一次 `modifyVisible`。
- 只有 AUTH（含 destroy 的 AUTH）是池级 fatal error；RISK 重试耗尽、普通 API 失败、PERM 与 destroy 非 AUTH 失败只计当前项失败并继续派工。
- 删除兜底继续默认关闭；开启时只有 PERM 项才调用 `destroy`，且继续显示不可逆确认。
- 停止操作继续通过同一个 `AbortSignal` 中止等待中和在途请求，不留下未等待的后台 Promise。
- AUTH 或 Abort 发生后必须等待全部已启动 worker promise settle，再让面板恢复 idle；服务端在中止前已接收的请求仍可能完成，日志不得承诺回滚。

### R4. UI、日志与兼容性

- 保留现有四种筛选和统计面板，仅增加并发数输入并更新限速默认值与说明。
- 预览/执行开始日志显示并发数和 10 秒请求额度，便于定位风控。
- 日志允许并发完成顺序与发起顺序不同，但统计必须准确，不输出微博正文到控制台错误日志。
- UID、SPA 刷新、dry-run、二次确认、筛选变更使预览失效等现有行为保持不变。
- userscript 版本升级为 `0.8.0`，头部 `@version` 与面板版本同步。

### R5. 操作期间屏蔽微博 RUM 上报

- 微博页面已加载 Elastic APM RUM，并会向 `https://rum.h5.weibo.cn/intake/v2/rum/events` 上报由扫描/执行 Fetch/XHR 产生的监控 payload；该请求不是 userscript 的业务 API。
- 预览扫描和真实执行期间，若页面暴露 `window.elasticApm.addFilter`，userscript 应通过官方 payload filter 返回 `false` 来临时丢弃 RUM payload；不得改写全局 `fetch` / `XMLHttpRequest`，不得调用或屏蔽四个业务 endpoint。
- 操作收尾后保留 3 秒静默宽限，再自动恢复 RUM payload 放行；恢复不得依赖可中止的业务 `AbortSignal`，停止/异常路径也必须执行。
- filter 只注册一次；连续操作或宽限期重叠时不得提前恢复。页面没有 Elastic APM 或 `addFilter` 不可用时应无副作用地继续原流程。
- 该机制只减少操作相关监控上报，不纳入全局业务 API 限流额度，也不得宣称能替代浏览器级网络拦截或保证屏蔽所有延迟上报。

## Acceptance Criteria

- [ ] 默认配置为并发 3、15 次/10 秒；面板输入分别限制在 1~3、1~15，并发设置为 1 时可串行运行。
- [ ] `searchProfile` 同一页波次最多 3 个请求在途，页结果按页码顺序处理，含边界游标、去重和终止语义不回归。
- [ ] `searchProfile.page` 被忽略时可识别相同 id 序列，并在后续轮次退回 page=1 游标模式。
- [ ] `mymblog` 最近 N/mid 扫描及深历史补扫保持逐页串行。
- [ ] 执行阶段最多 3 条待锁微博并发处理，完成后无孤儿请求继续修改数据。
- [ ] 四个接口调用均在 `fetch` 前调用统一 `rateLimiter.acquire(signal)`。
- [ ] AUTH、RISK、普通 API、PERM 与可选 destroy 的分类处理和计数正确。
- [ ] 最近 N、时间预设、日期范围、mid 范围、预览复用、停止和二次确认均保持可用。
- [ ] `@version` 与面板版本均为 `0.8.0`，脚本通过 JavaScript 语法检查。
- [ ] 预览/执行期间 APM filter 返回 falsy；所有退出路径结束抑制，3 秒宽限后自动放行；filter 仅注册一次且不改写 Fetch/XHR。
- [ ] 提供 Tampermonkey 人工验证步骤；未真实登录微博验证时不得声称已完成真实 API 验证。

## Out of Scope

- 修改微博内部 API endpoint、请求体或响应契约。
- 并发 `mymblog` 分页，或尝试未经验证的批量 `ids` 请求。
- 引入构建系统、依赖、自动化测试框架或新的运行时文件。
- 默认开启不可逆删除兜底。

## Technical Notes

- API 契约以 `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md` 为准。
- `searchProfile.data.total` 禁止作为终止条件；游标必须含边界推进。
- canonical id 继续使用 `statusId()` 返回的 `idstr`。
