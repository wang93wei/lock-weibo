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
- `.trellis/tasks/07-27-weibo-batch-locker/research/weibo-api-notes.md` — **verified API contract. Read before any API change.**

## Working on this repo

- **No npm/build/test.** Verify = install `.user.js` in Tampermonkey → logged-in `weibo.com/u/<uid>` → exercise panel.
- **Never trust memory for Weibo endpoints.** Undocumented internal AJAX; drift is real. Re-verify (DevTools / weibo-pro-next bundle) and update `weibo-api-notes.md` with date + source. Guide: `.trellis/spec/guides/third-party-api-verification-guide.md`.
- **Branch:** `main`. Only runtime artifact is the `.user.js`.

## Hard-won invariants (do not regress)

### Rate limit & risk control
- **Sliding window, not fixed delays.** `CONFIG.RATE_WINDOW_MS` / `RATE_MAX` (~3 req / 10s) throttle **all** of mymblog / searchProfile / modifyVisible via one global `rateLimiter.acquire(signal)`. Fixed delays triggered HTTP 414 /「频次过快」(commits `b2c4ecb`, `40ea1be`). New network calls must `acquire()` first.
- RISK → pause `RATE_LIMITED_WAIT_MS` (30s); other API errors → exponential backoff; AUTH → abort. Do not collapse RISK and non-RISK into the same branch.

### API contracts
| Call | Path | Notes |
|---|---|---|
| List (recent/mid) | `GET /ajax/statuses/mymblog` | page + `since_id`; ~20/page fixed |
| List (date/before) | `GET /ajax/statuses/searchProfile` | server-side time filter; **`page`/`max_id`/`since_id` ignored** — paginate by shrinking `endtime` to oldest item's `created_at` |
| Lock | `POST /ajax/statuses/modifyVisible` | form body `ids=<mid>&visible=1` (`visible` is **string** `"1"`) |

- **Headers:** `x-xsrf-token` (cookie `XSRF-TOKEN`), `x-requested-with`, plus mirror weibo-pro-next: `client-version` / `server-version` (from `window.$VERSION`) / `traceparent`. `credentials:"include"`. Do **not** set forbidden headers (cookie/UA/referer).
- **Response `visible`:** object `{ type, list_id }`, not a number. `isPrivate` uses `Number(blog.visible.type) === 1` (number **or** string `"1"`).

### Filter / flow semantics
- **最近 N 条:** newest-first continuous scan across pages; stop when hits (including already-private skips) reach N. **Never** per-page `slice(0, n)`.
- **时间预设 (before):** strictly **before** cutoff day (exclude cutoff date). UI:「早于 YYYY-MM-DD」. `searchProfile` `endtime` = cutoff 00:00:00.
- **日期范围:** closed interval on calendar days; uses searchProfile.
- **Preview → execute:** execute reuses `lastPreview.hits` via `lockByIds` (no second scan). Changing filter invalidates preview. Successful locks mutate `item.isPrivate = true`. Clear log also clears `lastPreview` + counters.
- **UID:** weibo is SPA — re-call `getUid()` on preview/run (`/u/<id>` or `/profile/<id>`), don't cache only at panel create.

### Safety & UX
- Dry-run default; real run needs second `confirm()`. Thread `AbortController` through every async path (Stop mid-scan).
- Tight await-loops must `await yieldToRender()` or the panel freezes while requests still fire.
- **Version sync:** bump **both** `// @version` header **and** `<small>vX.X.X</small>` in `BUILD_PANEL_HTML` (currently `0.6.5`).

## Conventions

- **Commits:** Chinese conventional-commits — `feat:` / `fix:` / `chore:` / `docs:` + 中文摘要, e.g. `fix: 修复批量扫描触发微博风控（414/频次过快）`.
- **Comments / UI:** 中文 for user-facing log/panel + rationale; English for symbols. Match surrounding style. Prefer small logs when debugging async flow.
- **License:** Apache-2.0 (not MIT).
