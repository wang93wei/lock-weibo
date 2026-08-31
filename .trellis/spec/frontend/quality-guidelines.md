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

## Scenario: Bounded Weibo Request Concurrency (v0.8.0)

### 1. Scope / Trigger

Apply this contract whenever changing `searchProfile` pagination, preview execution,
`modifyVisible` workers, cancellation, or request-rate controls. The goal is to overlap
network latency without creating unbounded requests, losing cursor coverage, or returning
the UI to idle while side effects are still running.

### 2. Signatures

```js
fetchSearchProfilePage({ uid, starttime, endtime, page }, signal)
runApiModeSearchProfile({ uid, starttime, endtime, concurrency, onLog, onProgress, signal })
runWorkerPool(items, concurrency, signal, workerFn)
lockByIds(hits, { concurrency, deletePerm, onLog, onProgress, signal })
```

Runtime bounds:

- `CONCURRENCY = 3`; panel input is clamped to `1..3` (`1` = serial fallback).
- `RATE_WINDOW_MS = 10000`, `RATE_MAX = 15`; panel can lower the limit to `1..15`.
- `SEARCH_PAGES_PER_WINDOW = 30`; `mymblog` pagination remains serial.
- `15/10s` was validated by the Python reference, not yet by Tampermonkey. Never describe
  it as browser-verified until a logged-in live run confirms it.

### 3. Contracts

- Every `searchProfile`, `mymblog`, `modifyVisible`, and `destroy` request calls the same
  `rateLimiter.acquire(signal)` immediately before `fetch()`.
- `searchProfile` runs fixed page waves and processes settled results in page-number order.
  Compare page 1/2 id sequences: identical non-empty sequences mean `page` is ignored;
  consume page 1 once and use page=1 for later `endtime` windows.
- The inclusive cursor is the oldest epoch among **all raw returned items** in the window,
  including already-seen boundary items. `seenMids` controls collection/counting only.
- `runWorkerPool` synchronously claims each item once. Only AUTH is pool-fatal; RISK/API/
  PERM/destroy non-AUTH failures remain per-item outcomes.
- `destroy` stays inside the owning lock worker and uses the same transient policy as other
  mutations: RISK waits `RATE_LIMITED_WAIT_MS`; ordinary API failures use exponential backoff.
  PERM means only the rejected `modifyVisible` call is not retried.
- Wave and worker promises must all settle before AUTH/Abort is rethrown. Abort stops client
  waiting and new assignment; it cannot roll back a request already accepted by Weibo.
- Preview hits remain the execution source of truth; execution does not rescan.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| page 1/2 id sequences differ | Enable bounded page waves |
| page 1/2 non-empty sequences match | Log drift warning; fall back to page=1 cursor mode |
| search page AUTH / Abort | Wait for the started wave to settle, then throw |
| search page non-AUTH failure | Log page + window, stop searchProfile, then retain fallback semantics |
| lock AUTH (including destroy AUTH) | Stop assigning new items, settle started workers, then throw |
| lock RISK exhausted / API / PERM | Count only that item as failed and continue |
| PERM + delete opt-in | Run JSON `destroy` in the same worker; keep default OFF |
| destroy RISK / API | Retry in the same worker with long-pause / exponential policy; non-AUTH exhaustion fails only that item |
| concurrency/rate input invalid | Clamp and write back before disabling inputs/start |

### 5. Good / Base / Bad Cases

- Good: concurrency 3, distinct page sequences, results complete out of order but are consumed
  in page order; each mid is assigned to one lock worker.
- Base: concurrency 1 produces serial page/lock behavior with the same cursor and errors.
- Bad: page is ignored, all concurrent pages are identical. Detect once and stop repeating
  duplicate page waves in later windows.
- Bad: one worker receives AUTH while two are in flight. Do not assign more mids; await the two
  workers before the panel becomes idle; completed mutations are not rolled back.

### 6. Tests Required

- Static: four `fetch` calls, each preceded by the global limiter; both displayed versions match.
- Controlled Node harness: page active/ignored, concurrency 1/3, inclusive oldest-raw cursor,
  once-only worker claims, out-of-order completion, RISK/PERM/destroy, AUTH/Abort all-settled,
  mixed-result statistics, and second-run skip behavior.
- Manual Tampermonkey: all four filters, real page drift/Referer, 15/10s risk behavior, stop,
  SPA UID, and small real execution. Treat delete testing as irreversible and opt-in only.

### 7. Wrong vs Correct

```js
// Wrong: unbounded side effects and an unsafe cursor derived only from new mids.
await Promise.all(hits.map(lockOne));
curEnd = oldestNewEpoch;

// Correct: bounded workers; cursor uses every raw boundary item.
await runWorkerPool(hits, concurrency, signal, lockOne);
curEnd = windowOldestRawEpoch;
```

---

## Elastic APM RUM Suppression During Operations

**What**: Preview and execution may best-effort suppress operation-related page RUM payloads
through `window.elasticApm.addFilter`. The filter returns `false` while an operation is active
and for at least 3 seconds after its release; outside that interval it returns the original
payload unchanged.

**Lifecycle contract**:

- Use only the public `addFilter` hook. Do not call `config({ active: false })`, inspect private
  agent fields, or monkey-patch `fetch` / `XMLHttpRequest`.
- Attempt filter registration at most once per agent object. Missing APM, missing `addFilter`,
  or a throwing registration is a no-op and must not interrupt the business operation.
- Maintain a shared active-operation count and a monotonic grace deadline. Each synchronous,
  idempotent release decrements the count once and advances the deadline to at least
  `Date.now() + 3000`; overlapping operations and grace windows must never restore early.
- Acquire suppression only after preview/run enters its busy operation state, then release in
  the outermost `finally` so success, early return inside the operation, AUTH, Abort, and
  unexpected errors all unwind. Do not start a release timer or orphan Promise.
- This is not a business API request and does not consume the global limiter. It is best-effort
  only: controlled VM checks cannot prove that real `rum.h5.weibo.cn` events are fully blocked.

---

## Forbidden Patterns

- Caching uid only at `createPanel` without SPA / action re-read
- Using URL profile id when the goal is locking the logged-in user's posts
- Fixed request delays instead of the global sliding-window `rateLimiter` (see `AGENTS.md`)
- Unbounded `Promise.all(hits.map(...))`, parallel `mymblog` pagination, or any fetch that
  bypasses the global limiter
- Advancing a concurrent search window from only the oldest *new* mid; use the oldest epoch
  from all raw returned items so boundary duplicates preserve same-second coverage
- Throwing AUTH/Abort from a page wave or lock pool before all already-started promises settle
- Trusting `searchProfile` `data.total` as a termination condition; exclusive (`-1`) cursor advance
- Retrying permanent business rejections as transient errors: `modifyVisible` HTTP 400 + 「暂不支持变更可见范围」（响应体字段是 `message` 不是 `msg`）→ `PERM` 码，单条只发 1 次请求；失败详情用 `console.error("[wbl] ...")` 输出到 DevTools（2026-08-29 实测，见 API 笔记第 3 节）
- Re-registering an Elastic APM filter for the same agent, toggling undocumented APM state,
  or claiming VM/static verification proves real RUM intake suppression

---

## Testing Requirements

- Manual: reload `.user.js` → open `weibo.com/` (must show `当前 UID: …`) → SPA navigate to `/u/<uid>` (hint stays correct, no full reload)
- No automated test suite for this package
