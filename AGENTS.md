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

# Project: lock-weibo

Batch-set own weibo posts to「仅自己可见」(`visible.type=1`). **Single** Tampermonkey userscript — no build, bundler, package.json, tests, or linter.

## Source map

- `scripts/weibo-batch-locker.user.js` — entire app (~1500 lines, one IIFE, `"use strict"`). Top→bottom:
  - `CONFIG` + `VISIBLE_TEXT`
  - Auth / date / mid utils + filters
  - Global `rateLimiter` (sliding window)
  - API: `fetchBlogPage` (mymblog), `fetchSearchProfilePage`, `modifyVisible`
  - Orchestration: `runApiMode` (mymblog path), `runApiModeSearchProfile` (date/before), `lockByIds` (execute from preview)
  - Shadow DOM UI: `createPanel`, `BUILD_PANEL_HTML`, `boot`
- `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md` — **verified API contract. Read before any API change.**

## Working on this repo

- **No npm/build/test.** Verify = install `.user.js` in Tampermonkey → logged-in `weibo.com/u/<uid>` → exercise panel.
- **Never trust memory for Weibo endpoints.** Undocumented internal AJAX; drift is real. Re-verify (DevTools / weibo-pro-next bundle) and update `weibo-api-notes.md` with date + source. Guide: `.trellis/spec/guides/third-party-api-verification-guide.md`.
- **Branch:** `main`. Only runtime artifact is the `.user.js`.

## Hard-won invariants (do not regress)

### Rate limit & risk control
- **Sliding window, not fixed delays.** `CONFIG.RATE_WINDOW_MS` / `RATE_MAX` (~3 req / 10s) throttle **all** of mymblog / searchProfile / modifyVisible via one global `rateLimiter.acquire(signal)`. Fixed delays triggered HTTP 414 /「频次过快」(commits `b2c4ecb`, `40ea1be`). New network calls must `acquire()` first.
- RISK → pause `RATE_LIMITED_WAIT_MS` (30s); other API errors → exponential backoff; AUTH → abort. Do not collapse RISK and non-RISK into the same branch.
- 业务**永久拒绝**（`modifyVisible` 400 + 「暂不支持变更可见范围」，响应体字段 `message` 非 `msg`）→ `PERM` 码：单条只发 1 次请求、计 1 次失败，不进退避重试；失败详情 `console.error("[wbl] ...")` 输出 DevTools（2026-08-29 实测，见 API 笔记第 3 节）。

### API contracts
| Call | Path | Notes |
|---|---|---|
| List (recent/mid) | `GET /ajax/statuses/mymblog` | page + `since_id`; ~20/page fixed |
| List (date/before) | `GET /ajax/statuses/searchProfile` | server-side time filter; cursor rounds via shrinking `endtime` to oldest item's `created_at` are MANDATORY — single query has a ~1000-item depth cap (page honored 2026-08-29 but caps out at ~21 pages; ignored entirely 2026-07-27; never rely on `page` for depth). Index may not cover deep history (bottomed ~4821 items / ~2010-04 vs mymblog total ~8270) → mymblog sweep fallback |
| Lock | `POST /ajax/statuses/modifyVisible` | form body `ids=<idstr>&visible=1` (`visible` is **string** `"1"`) |
| Delete | `POST /ajax/statuses/destroy` | **JSON** body `{"id":"<idstr>"}` (JSON ONLY — form-encoded gets a plain gateway 400); irreversible, opt-in PERM fallback; PERM-rejected posts ARE deletable (verified 2026-08-29) |

- **Headers:** `x-xsrf-token` (cookie `XSRF-TOKEN`), `x-requested-with`, plus mirror weibo-pro-next: `client-version` / `server-version` (from `window.$VERSION`) / `traceparent`. `credentials:"include"`. Do **not** set forbidden headers (cookie/UA/referer).
- **Response `visible`:** object `{ type, list_id }`, not a number. `isPrivate` uses `Number(blog.visible.type) === 1` (number **or** string `"1"`).
- **Canonical id = `idstr`.** 2010-era posts have `id ≠ mid` (idstr `1315558541` vs mid `20110072529369342`); `modifyVisible`/`destroy` take the idstr — use the `statusId()` helper, never `blog.mid` for operations (modern posts: id == idstr == mid).

### Filter / flow semantics
- **最近 N 条:** newest-first continuous scan across pages; stop when hits (including already-private skips) reach N. **Never** per-page `slice(0, n)`.
- **时间预设 (before):** strictly **before** cutoff day (exclude cutoff date). UI:「早于 YYYY-MM-DD」. `searchProfile` `endtime` = cutoff 00:00:00.
- **日期范围:** closed interval on calendar days; uses searchProfile.
- **Preview → execute:** execute reuses `lastPreview.hits` via `lockByIds` (no second scan). Changing filter invalidates preview. Successful locks mutate `item.isPrivate = true`. Clear log also clears `lastPreview` + counters.
- **UID:** prefer login `$CONFIG.uid` / `$CONFIG.user.idstr` (own posts only); URL `/u|profile/<id>` is fallback. Re-call on preview/run; SPA `pushState`/`replaceState`/`popstate` refreshes the panel hint (don't cache only at create).

### Safety & UX
- Dry-run default; real run needs second `confirm()`. Thread `AbortController` through every async path (Stop mid-scan).
- **PERM→删除兜底 (v0.7.0):** panel checkbox「删除兜底」default OFF; when ON, modifyVisible PERM-rejected posts are deleted via `destroy` (irreversible — confirm dialog carries a loud warning; deleted mids get `isPrivate = true` so a second「执行」won't re-hit them).
- **searchProfile 索引见底 → mymblog 兜底 (v0.7.0):** time-filter previews that stop before reaching `starttime` automatically sweep mymblog (start page = scanned/20 − 30 margin, page cold-jump OK, empty page = account bottom).
- Tight await-loops must `await yieldToRender()` or the panel freezes while requests still fire.
- **Version sync:** bump **both** `// @version` header **and** `<small>vX.X.X</small>` in `BUILD_PANEL_HTML` (currently `0.7.0`).
- **searchProfile 终止条件:** `data.total` 大窗口下饱和不可信（~1000±10，与窗口内容脱钩），禁做终止条件；游标**含边界**推进（`curEnd = oldestEpoch`）+ `seenMids` 去重，`-1` 不含边界会丢跨分页边界的同秒帖（2026-08-29 实测，见 API 笔记第 6 节）。

## Conventions

- **Commits:** Chinese conventional-commits — `feat:` / `fix:` / `chore:` / `docs:` + 中文摘要, e.g. `fix: 修复批量扫描触发微博风控（414/频次过快）`.
- **Comments / UI:** 中文 for user-facing log/panel + rationale; English for symbols. Match surrounding style. Prefer small logs when debugging async flow.
- **License:** Apache-2.0 (not MIT).
