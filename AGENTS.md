<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# Repository Guidelines

## Project Overview

`lock-weibo` 是直接运行在已登录 `weibo.com` 页面中的单文件 userscript，用四类筛选条件预览并批量把当前账号的微博设为「仅自己可见」(`visible.type=1`)。默认 dry-run；真实修改需要二次确认并可停止。「同时取消快转」与「PERM 删除兜底」是两个独立、默认关闭的选项；删除不可逆。

- 唯一产品运行时：`scripts/weibo-batch-locker.user.js`。
- 无外部运行时依赖、后端、构建产物或发布流水线。
- 产品许可证：Apache-2.0。

## Architecture & Data Flow

```text
boot → profile/SPA route gate → createPanel (Shadow DOM)
  preview → doPreview
    recent/mid → runApiMode → mymblog 串行分页
    date/before → runApiModeSearchProfile → searchProfile 有界页波次 → mymblog 深历史兜底
  execute → sameFilterCfg + confirm → lockByIds → runWorkerPool
    → 锁定 worker：modifyVisible → [PERM + opt-in] destroyStatus
    → 锁定阶段收尾后，取消快转 worker：destroyQuickRepost
```

- 源码按 `CONFIG`/RUM、身份与动作工具、限流/API、纯筛选器、扫描/执行、Shadow DOM UI、`boot()` 分区。四个端点、四处业务 fetch；`destroyStatus()` 与 `destroyQuickRepost()` 共用 `requestDestroy()`，不是第五个端点。
- `makePreviewItem()` 统一生成 `lock | cancelQuickRepost | skip` 动作，预览缓存为 `state.lastPreview = {hits, filterCfg, at}`。执行只消费快照，不重新扫描或核验可见性；按 `action` 与 `completed` 统计待办，成功后原地标记完成，不得仅按 `isPrivate` 判断。
- `runApiModeSearchProfile()` 使用含边界的 `curEnd = oldestEpoch` 和 `seenMids` 去重；不得用饱和且不可靠的 `data.total` 提前终止，也不得把游标减一。索引未覆盖 `starttime` 时必须保留 `mymblog` 补扫。
- 三个页面级滑动窗口限流桶分管 `mymblog`（严格，页间隙+深页加压）、`searchProfile`（宽松）、`modifyVisible`/`destroy`（写桶固定）。一个 action 级 `AbortController` 贯穿限流等待、sleep、fetch、分页和 worker；已完成的服务端修改不回滚。
- 状态只存在页面内存：IIFE 全局状态、panel 闭包状态、单次操作局部状态。刷新页面会丢失；没有 `localStorage`、IndexedDB 或 GM 存储。
- SPA 离开个人页仅隐藏面板，不销毁快照、不自动停止操作。数字个人页路由不证明内容属于登录用户；预览也没有自动过期或账户绑定保证。
- Elastic APM RUM 抑制是 best-effort payload filter，不拦截业务 fetch；释放逻辑必须留在 `finally`。

## Key Directories

- `scripts/` — 产品源码；当前只有自包含 userscript。
- `.trellis/spec/` — 持久的项目约束与思考指南；改代码前读取相关层。
- `.trellis/tasks/` — PRD、设计、实现计划、研究和归档证据。
- `.trellis/workspace/` — 开发者 journal/session 记录，不是产品状态。
- `.trellis/scripts/` — Trellis 工作流命令。
- `.agent/`、`.agents/`、`.claude/`、`.codex/`、`.opencode/`、`.zcode/` — AI 平台集成；不得当作产品运行时、依赖或测试设施。

## Development Commands

产品没有 install、build、bundle、format、lint、type-check 或自动化 test 命令。不要运行或文档化不存在的 `npm install` / `npm run ...` 流程。

```bash
# 加载 Trellis 会话上下文
python3 ./.trellis/scripts/get_context.py

# JavaScript 语法检查；不代表浏览器行为通过
node --check scripts/weibo-batch-locker.user.js

# 补丁空白检查；不代表功能通过
git diff --check
```

运行方式：在兼容的 userscript 管理器中安装或重新加载 `scripts/weibo-batch-locker.user.js`，登录 PC 版 `weibo.com`，进入自己的 `/u/<uid>` 或 `/profile/<uid>` 页面操作面板。应用代码修改无需生成其他文件。

## Code Conventions & Common Patterns

- 保持单文件 strict-mode IIFE 和现有分区；不要引入第二套模块、依赖注入框架、状态库、构建链或外部依赖。
- 沿用邻近代码的两空格缩进、分号与双引号。英文 `camelCase` 符号，大写配置键，DOM id/class 使用 `wbl-` 前缀，控制台使用 `[wbl]` 前缀。用户可见 UI/日志和关键缘由注释用中文；远端文本用 `textContent`，不拼成 HTML。
- 无 DI 容器。长异步流通过 options object 显式传递 `onLog`、`onProgress`、`signal` 等依赖；沿用邻近调用模式。
- 普通微博的身份、去重、筛选、锁定和删除使用 `statusId(blog)` 的 canonical ID（`idstr ?? id ?? mid`）；大 ID 保持字符串，比较用 `cmpMid()`，不要转 `Number`。预览字段 `mid` 也保存 canonical ID。
- 快转由 `isQuickRepost()` 识别，不能与普通转发混同；快转判断先于原帖私密状态。默认跳过，开启取消后必须以 `ori_mid` 作为 `actionId`；缺失时安全跳过，绝不能替换成展示原帖 ID。
- `destroy` 共用 JSON `{id: String(id)}` 传输，但两个业务封装不可合并：普通删除允许成功响应缺少 `ok`；快转取消必须 HTTP 成功且 JSON `ok > 0`。
- UID 优先取登录态 `$CONFIG.uid` / `$CONFIG.user.idstr`，个人页 URL 仅兜底；每次预览/执行重新读取。`boot()` 必须继续跟踪 `pushState`、`replaceState`、`popstate`。
- 四个业务 fetch 前都必须 `await` 各自限流桶的 `acquire(signal)`（`searchLimiter` / `timelineLimiter` / `writeLimiter`），并继续使用 `credentials: "include"` 与 `apiHeaders()`。新增网络调用必须接入对应桶和 AbortSignal。
- mutation 先用 `readApiBody()` 保留正文，再分类错误。`AUTH`/Abort 停止派发并等待在途 worker 收尾；`RISK` 在当前请求重试分支按 `RATE_LIMITED_WAIT_MS` 等待，不是全局熔断；网络/5xx 指数退避。普通锁定/快转的 `NOT_OWN` 跳过，`BUSINESS` 当次记失败、后续跳过，不盲目重试。
- `PERM` 不重试 `modifyVisible`；当前 UI 的 `lockByIds()` 仅对 `action === "lock"` 且开启删除兜底的项目调用 `destroyStatus()`。取消快转失败不得落入删帖兜底。不要把保留的 `runApiMode()` 非 dry-run 分支当成新的 UI 执行入口。
- 「最近 N 条」按 newest-first 跨页连续计数，已私密项与快转跳过项也占 N。日期复用现有工具，注意浏览器本地时区；QA 覆盖 before 截止日与日期范围两端边界，不假设硬编码北京时间。
- dry-run、执行前 `sameFilterCfg()`（含快转开关）、原生 `confirm()`、预览复用、两个危险选项默认关闭均为安全边界。异步流显式传递 `signal`，紧密 await 循环保留 `yieldToRender()`。
- 发布版本必须同步 userscript header 的 `// @version` 与 `BUILD_PANEL_HTML()` 中的 `<small>v…</small>`；不要在指南里复制会漂移的当前版本或默认限速值，以源码 `CONFIG` 为准。
- 提交信息使用中文 conventional commits，例如 `fix: 修复批量扫描触发微博风控`。代码和提交应保持小而聚焦。

微博 AJAX 是未公开且会漂移的内部接口。修改 endpoint、method、参数类型、响应结构、鉴权 header 或枚举前，必须依据当前官方前端 bundle 或登录态 DevTools Network 一手复核；第三方资料只能作线索。把核验日期、来源和结论追加到 `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md`。

## Important Files

- `scripts/weibo-batch-locker.user.js` — 唯一入口、源码和直接分发物。
- `README.md` — 安装、使用和风险说明入口；目前快转说明及“所有修改用 idstr”的描述尚未同步，以当前实现及最新 API 证据为准。
- `.trellis/spec/frontend/quality-guidelines.md` — 并发、分页、取消、RUM、版本同步和 QA 不变量。
- `.trellis/spec/guides/third-party-api-verification-guide.md` — 未公开第三方 API 的核验流程。
- `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md` — 带日期的一手 API 证据；旧段落可能已被后续记录推翻，应按最新结论阅读。
- `.trellis/tasks/archive/2026-08/08-12-quick-repost-skip/prd.md` — 快转行为与验收场景；历史验证不等于当前版本通过。
- `.trellis/workflow.md` — 任务阶段、spec 更新与提交工作流。
- `LICENSE` — Apache License 2.0。

## Runtime/Tooling Preferences

- 产品运行时是浏览器 userscript 环境：`@match https://weibo.com/*`、`@run-at document-idle`、`@grant none`。依赖 `window`、DOM、Fetch、Cookie 登录态和 `AbortController`，不依赖 Node 或 Python。
- `node` 仅用于可选语法检查；Python 仅用于 Trellis/AI hooks。不要把两者声明为产品运行时。
- 根目录没有产品 package manifest 或 package manager。`.opencode/package.json` 仅属于 OpenCode 助手集成，其 lockfile 和 Node engine 不约束产品。
- `.user.js` 是直接维护、直接分发的源文件，不是可丢弃的 generated bundle。不要创建 `dist/`、source map 或并行实现。
- 保持 `@grant none` 和无 GM API 的现状，除非需求明确要求改变权限模型并完成浏览器验证。

## Testing & QA

仓库没有常驻产品测试套件、测试框架、CI 配置或覆盖率阈值。历史归档记录过临时 Node VM harness，但未保留可直接运行的入口。`node --check` 只覆盖语法；显著行为变更需受控行为检查和真实页面验证，不能用历史结果代替本次验证。

1. 重载 userscript；确认微博首页不显示面板，进入自己的 `/u/<uid>` 或 `/profile/<uid>` 后显示，UID 来自登录账号，SPA 往返时正确隐藏/恢复。
2. 对最近 N、时间预设、日期范围、mid 范围分别做 dry-run；确认不会锁定、删除或取消快转，筛选/快转开关变化会阻止旧预览执行。
3. 两个危险选项保持关闭，用少量已知安全微博验证二次确认、预览复用、已私密项跳过、分项计数与再次执行不重复处理。
4. 快转检查：与普通转发正确区分；仍计入最近 N；缺 `ori_mid` 跳过；显式开启后抓包核对关系 ID、先锁后取消、成功项不重发、取消失败不触发删帖兜底。关闭取消不代表整个 `destroy` 端点禁用，独立的删帖选项也使用它。
5. 验证两个执行阶段的 Stop/AUTH 不再分配新任务，在途 worker 收尾后回到 idle，已完成变更不回滚。覆盖并发 1/3、414/429/「频次过快」的 RISK 等待；真实请求先用并发 1、低额度。
6. 分页覆盖 `searchProfile.page` 生效/被忽略、同秒边界去重与 `mymblog` 深历史补扫。涉及 API、分页、限流或 RUM 时检查 Network/Console 并更新 API notes；默认额度及 mock RUM 检查不等于登录态安全保证。

删除验证只能在明确可丢弃的微博上由用户显式授权执行；取消快转同样有真实副作用。未完成登录态验证时，交付必须区分语法、受控行为与真实页面检查，不能宣称端到端通过。旧 QA 文档的“首页显示 UID”已陈旧，应遵循当前个人页路由门禁。
