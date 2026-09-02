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

`lock-weibo` 是一个直接运行在已登录 `weibo.com` 页面中的单文件 userscript，用四类筛选条件预览并批量把当前账号的微博设为「仅自己可见」(`visible.type=1`)。默认 dry-run；真实修改需要二次确认并可停止。删除只用于 `modifyVisible` 永久拒绝后的显式兜底，默认关闭且不可逆。

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
    → modifyVisible → [PERM + opt-in] destroyStatus
```

- 源码自上而下分为：`CONFIG`/RUM 抑制、身份/日期/ID 工具、全局 `rateLimiter`、四个 API helper、筛选器、扫描/执行编排、Shadow DOM UI、`boot()`。
- 预览统一生成 `stats.hits`，并缓存到面板闭包的 `state.lastPreview`。执行只消费这批结果，不重新扫描；成功锁定或删除后原地写入 `item.isPrivate = true`。
- `runApiModeSearchProfile()` 使用含边界的 `curEnd = oldestEpoch` 和 `seenMids` 去重；不得用饱和且不可靠的 `data.total` 提前终止，也不得把游标减一。索引未覆盖 `starttime` 时必须保留 `mymblog` 补扫。
- 一个页面级滑动窗口限流器覆盖 `mymblog`、`searchProfile`、`modifyVisible`、`destroy`。一个 action 级 `AbortController` 贯穿限流等待、sleep、fetch、分页和 worker；已完成的服务端修改不回滚。
- 状态只存在页面内存：IIFE 全局状态、panel 闭包状态、单次操作局部状态。刷新页面会丢失；没有 `localStorage`、IndexedDB 或 GM 存储。
- Elastic APM RUM 抑制是 best-effort payload filter，不拦截业务 fetch；释放逻辑必须留在 `finally`。

## Key Directories

- `scripts/` — 产品源码；当前只有自包含 userscript。
- `.trellis/spec/` — 持久的项目约束与思考指南；改代码前读取相关层。
- `.trellis/tasks/` — PRD、设计、实现计划、研究和归档证据。
- `.trellis/workspace/` — 开发者 journal/session 记录，不是产品状态。
- `.trellis/scripts/` — Trellis 工作流命令。
- `.agents/`、`.claude/`、`.codex/`、`.opencode/`、`.zcode/` — AI 平台集成；不得当作产品运行时、依赖或测试设施。

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
- 英文 `camelCase` 符号，大写配置键，DOM id/class 使用 `wbl-` 前缀，控制台使用 `[wbl]` 前缀。用户可见 UI/日志和关键缘由注释用中文。
- 无 DI 容器。长异步流通过 options object 显式传递 `onLog`、`onProgress`、`signal` 等依赖；沿用邻近调用模式。
- 身份、去重、筛选和修改统一使用 `statusId(blog)` 产生的 canonical `idstr`。旧微博可能 `idstr !== mid`，不得直接把 `blog.mid` 传给修改/删除接口。
- UID 优先取登录态 `$CONFIG.uid` / `$CONFIG.user.idstr`，个人页 URL 仅兜底；每次预览/执行重新读取。`boot()` 必须继续跟踪 `pushState`、`replaceState`、`popstate`。
- 四个业务 fetch 前都必须 `await rateLimiter.acquire(signal)`，并继续使用 `credentials: "include"` 与 `apiHeaders()`。新增网络调用必须接入同一限流器和 AbortSignal。
- 错误分支不可合并：`AUTH`/Abort 终止操作；`RISK` 按 `RATE_LIMITED_WAIT_MS` 暂停；普通瞬时错误指数退避；`PERM` 不重试 `modifyVisible`，只在用户开启「删除兜底」后调用 `destroyStatus`。
- 「最近 N 条」按 newest-first 跨页连续计数，已私密项也占 N；before 严格早于 cutoff 当天；日期范围是日历日闭区间。
- dry-run、执行前 `sameFilterCfg()` 校验、原生 `confirm()`、预览结果复用、删除默认关闭均为安全边界。紧密 await 循环保留 `yieldToRender()`。
- 发布版本必须同步 userscript header 的 `// @version` 与 `BUILD_PANEL_HTML()` 中的 `<small>v…</small>`；不要在指南里复制会漂移的当前版本或默认限速值，以源码 `CONFIG` 为准。
- 提交信息使用中文 conventional commits，例如 `fix: 修复批量扫描触发微博风控`。代码和提交应保持小而聚焦。

微博 AJAX 是未公开且会漂移的内部接口。修改 endpoint、method、参数类型、响应结构、鉴权 header 或枚举前，必须依据当前官方前端 bundle 或登录态 DevTools Network 一手复核；第三方资料只能作线索。把核验日期、来源和结论追加到 `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md`。

## Important Files

- `scripts/weibo-batch-locker.user.js` — 唯一入口、源码和直接分发物。
- `README.md` — 当前用户功能、安装、使用和风险说明。
- `.trellis/spec/frontend/quality-guidelines.md` — 并发、分页、取消、RUM、版本同步和 QA 不变量。
- `.trellis/spec/guides/third-party-api-verification-guide.md` — 未公开第三方 API 的核验流程。
- `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md` — 带日期的一手 API 证据；旧段落可能已被后续记录推翻，应按最新结论阅读。
- `.trellis/workflow.md` — 任务阶段、spec 更新与提交工作流。
- `LICENSE` — Apache License 2.0。

## Runtime/Tooling Preferences

- 产品运行时是浏览器 userscript 环境：`@match https://weibo.com/*`、`@run-at document-idle`、`@grant none`。依赖 `window`、DOM、Fetch、Cookie 登录态和 `AbortController`，不依赖 Node 或 Python。
- `node` 仅用于可选语法检查；Python 仅用于 Trellis/AI hooks。不要把两者声明为产品运行时。
- 根目录没有产品 package manifest 或 package manager。`.opencode/package.json` 仅属于 OpenCode 助手集成，其 lockfile 和 Node engine 不约束产品。
- `.user.js` 是直接维护、直接分发的源文件，不是可丢弃的 generated bundle。不要创建 `dist/`、source map 或并行实现。
- 保持 `@grant none` 和无 GM API 的现状，除非需求明确要求改变权限模型并完成浏览器验证。

## Testing & QA

仓库没有 checked-in 产品测试套件、测试框架、CI、覆盖率、linter、type checker 或 build。`node --check` 只覆盖语法；显著行为变更必须在真实页面验证。

1. 重载 userscript；确认微博首页不显示面板，进入自己的 `/u/<uid>` 或 `/profile/<uid>` 后显示，UID 来自登录账号，SPA 往返时正确隐藏/恢复。
2. 对最近 N、时间预设、日期范围、mid 范围分别做 dry-run；确认不会调用修改/删除接口，筛选变化会阻止不匹配的旧预览执行。
3. 保持「删除兜底」关闭，用少量已知安全微博验证二次确认、预览复用、已私密项跳过、计数和再次执行不重复处理。
4. 验证 Stop 不再分配新任务，已发请求会收尾且已完成变更不回滚。遇到 414/429/「频次过快」时确认进入 RISK 暂停；保守验证先用并发 1、低请求额度。
5. 涉及 API、分页、限流或 RUM 时，同时检查 DevTools Network/Console，并按验证指南更新 API notes。默认请求额度不等于已证明的 Tampermonkey 登录态安全值。

删除验证不可逆，只能在明确可丢弃的微博上由用户显式授权执行。未完成真实登录态验证时，交付说明必须准确写明只做了哪些静态检查，不能宣称端到端通过。
