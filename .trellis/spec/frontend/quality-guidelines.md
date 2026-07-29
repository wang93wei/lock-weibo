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

## Forbidden Patterns

- Caching uid only at `createPanel` without SPA / action re-read
- Using URL profile id when the goal is locking the logged-in user's posts
- Fixed request delays instead of the global sliding-window `rateLimiter` (see `AGENTS.md`)

---

## Testing Requirements

- Manual: reload `.user.js` → open `weibo.com/` (must show `当前 UID: …`) → SPA navigate to `/u/<uid>` (hint stays correct, no full reload)
- No automated test suite for this package
