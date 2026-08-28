# Quality Guidelines

> Code quality standards for this project's frontend (single Tampermonkey userscript).

---

## Overview

Runtime artifact is only `scripts/weibo-batch-locker.user.js`. No bundler, lint, or unit tests. Verify by reloading the script in Tampermonkey on logged-in `weibo.com`.

Project-level invariants also live in `AGENTS.md` — keep both in sync when conventions change.

---

## UID Resolution (login, not page owner)

**What**: `getUid()` must return the **logged-in** user's id. Prefer `window.$CONFIG.uid` / `$CONFIG.user.idstr` / `$CONFIG.user.id`; fall back to URL `/u/<id>` or `/profile/<id>`.

**Why**: Weibo is an SPA. Homepage `/` has no uid in the path, but `$CONFIG.uid` is present after login. The tool only locks **own** posts — never treat "profile being viewed" as the target uid when it differs from login.

**SPA UI**: Panel `#wbl-uid` must refresh on `history.pushState` / `replaceState` / `popstate` (`onSpaNavigate`), not only at panel create or preview/run click.

```js
// Good
const fromCfg = window.$CONFIG?.uid ?? window.$CONFIG?.user?.idstr;
// Bad — homepage always fails; SPA route change leaves stale hint
const m = location.pathname.match(/\/u\/(\d+)/);
```

---

## Version Sync

Bump **both** `// @version` in the userscript header and `<small>vX.X.X</small>` in `BUILD_PANEL_HTML` together.

---

## SearchProfile Scan Termination

**What**: `runApiModeSearchProfile` must terminate on: empty slice / `newCount === 0`（无新 mid）/ cursor below `starttime` / `MAX_PAGES_FALLBACK` / abort. The cursor advances **inclusively** (`curEnd = oldestEpoch`) with `seenMids` dedupe — never `oldestEpoch - 1`.

**Why**: `searchProfile` 的 `data.total` 在大时间窗下是饱和近似值（~1000±10，且与窗口内容脱钩），拿它做 `hits >= total` 早停会在 ~1000 条处静默截断深历史扫描（2026-08-29 实测，详见 API 笔记第 6 节）。`-1` 不含边界推进则会在 50 条分页边界切开**同秒发布组**时丢帖——被切开的余下同秒帖子两个窗口都取不到。

```js
// Good — inclusive advance, dedupe via seenMids, terminate on no-new-mid
const nextEnd = oldestEpoch;
if (nextEnd > curEnd) break;           // no progress → newCount===0 will catch it
// Bad — total early-stop truncates deep history; -1 drops same-second tails
if (stats.hits.length >= serverTotal) break;
const nextEnd = oldestEpoch - 1;
```

---

## Forbidden Patterns

- Caching uid only at `createPanel` without SPA / action re-read
- Using URL profile id when the goal is locking the logged-in user's posts
- Fixed request delays instead of the global sliding-window `rateLimiter` (see `AGENTS.md`)
- Trusting `searchProfile` `data.total` as a termination condition; exclusive (`-1`) cursor advance
- Retrying permanent business rejections as transient errors: `modifyVisible` HTTP 400 + 「暂不支持变更可见范围」（响应体字段是 `message` 不是 `msg`）→ `PERM` 码，单条只发 1 次请求；失败详情用 `console.error("[wbl] ...")` 输出到 DevTools（2026-08-29 实测，见 API 笔记第 3 节）

---

## Testing Requirements

- Manual: reload `.user.js` → open `weibo.com/` (must show `当前 UID: …`) → SPA navigate to `/u/<uid>` (hint stays correct, no full reload)
- No automated test suite for this package
