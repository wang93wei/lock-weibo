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

Batch-set your own weibo posts to "仅自己可见" (private, `visible.type=1`). Ships as a **single Tampermonkey/Greasemonkey userscript** — there is no build step, bundler, package.json, test suite, or linter.

## Source map

- `scripts/weibo-batch-locker.user.js` — the entire app (~980 lines, one IIFE, `"use strict"`). Internal layout, top to bottom:
  - `CONFIG` constants (page size, rate-limit window, retry policy, `PRIVATE_TYPE: 1`) + `VISIBLE_TEXT` enum
  - Auth helpers (`getUid`, `getXsrfToken`)
  - Date / `mid` utilities + filters (`byDateRange`, `byMidRange`, `byBeforeMonths`, `byRecentN`, `applyFilter`)
  - `createRateLimiter()` → one **global** `rateLimiter` instance shared by all requests
  - API layer: `apiHeaders`, `fetchBlogPage` (list), `modifyVisible` (lock)
  - `runApiMode` orchestration (dry-run, retry/backoff, abort)
  - UI panel: `createPanel`, `BUILD_PANEL_HTML`, `boot`
- `.trellis/tasks/07-27-weibo-batch-locker/research/weibo-api-notes.md` — **the verified Weibo API contract. Read this before touching the API layer.**

## Working on this repo

- **No build/test commands.** "Verify" means: install the edited `.user.js` in Tampermonkey, open `weibo.com` while logged in, and exercise the panel. There is nothing to `npm run`.
- **Never trust memory for Weibo endpoints.** These are undocumented internal AJAX APIs that drift. Before adding/changing any call, re-verify first-hand (DevTools Network capture or the platform's own JS bundle) and update `research/weibo-api-notes.md` with the date + source. See `.trellis/spec/guides/third-party-api-verification-guide.md`. Past drift already caused real bugs (endpoint renamed, `visible` reshaped from number to object, value-type number→string).

## Hard-won invariants (do not regress)

- **Rate limiting is a sliding window, not fixed delays.** `CONFIG.RATE_WINDOW_MS` / `RATE_MAX` (~3 req / 10s) throttle *both* `mymblog` pagination and `modifyVisible` via the single global `rateLimiter.acquire(signal)`. Fixed inter-request delays triggered Weibo risk control (HTTP 414 / "频次过快") — see commits `b2c4ecb`, `40ea1be`. Any new network call must go through `rateLimiter.acquire()` first.
- **Value-type gotcha:** in `modifyVisible`, `visible` is the **string** `"1"` in the form body; in the `mymblog` response it is the **object** `{ type, list_id }`. `isPrivate(blog)` checks `blog.visible.type === 1`, not `blog.visible === 1`.
- **Auth headers:** `x-xsrf-token` (read from the `XSRF-TOKEN` cookie via `document.cookie`) + `x-requested-with: XMLHttpRequest`. POST bodies are `application/x-www-form-urlencoded`.
- **Safety defaults:** dry-run is the default; real execution requires a second `confirm()`. Every async op threads an `AbortController` signal so the Stop button works mid-scan. Preserve both when editing `runApiMode` / `doRun`.
- **Version sync:** when bumping the version, update **both** `// @version` in the userscript header **and** the `<small>vX.X.X</small>` in `BUILD_PANEL_HTML` (currently `0.4.0`).

## Conventions

- **Commits:** Chinese conventional-commits style — `feat:` / `fix:` / `chore:` / `docs:` followed by a Chinese summary, e.g. `fix: 修复批量扫描触发微博风控（414/频次过快）`.
- **Code comments / UI strings:** bilingual is fine — Chinese for user-facing log/panel text and rationale comments, English for symbol names and structure. Match the surrounding style.
- **Branch:** work happens on `main`. The repo's only runtime artifact is the `.user.js` file itself.
