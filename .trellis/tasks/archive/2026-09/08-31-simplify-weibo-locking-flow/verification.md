# Verification Results

## Automated / Controlled

- `node --check scripts/weibo-batch-locker.user.js`: PASS
- `git diff --check`: PASS
- Endpoint/limiter static audit: PASS (4 fetch calls; 4 acquire calls)
- Version sync: PASS (`@version 0.8.0`, panel `v0.8.0`)
- Temporary Node controlled harness (not added to repository): PASS
  - Elastic APM filter registers once per agent
  - registration is attempted only once when `addFilter` throws; missing/invalid/throwing APM is a no-op
  - active preview/run suppression returns falsy
  - release is synchronous and idempotent
  - overlapping operations and an operation started during grace do not restore early
  - payload remains suppressed for 3 seconds after the last release, then passes through unchanged
  - missing Elastic APM is a no-op
  - `doPreview` / `doRun` acquire suppression after entering busy state and release it in their outermost `finally`
  - bounded worker claim and out-of-order completion
  - concurrency 1/3
  - RISK retry/exhaustion, PERM, destroy success/non-AUTH failure, destroy RISK/API retry
  - AUTH stops new claims and waits started workers
  - Abort waits started workers
  - mixed statistics and second-run skip
  - searchProfile page active/ignored fallback
  - inclusive oldest-raw cursor and ordered page merge

No linter, type checker, build, or repository test suite exists for this single userscript.

## Not Verified

- No logged-in Tampermonkey or real Weibo API call was performed.
- The default 15 requests / 10 seconds is proven only by the Python reference; browser risk behavior remains to be verified.
- No real `modifyVisible` or irreversible `destroy` call was made.
- Elastic APM RUM suppression was verified only in a controlled Node VM with a mock
  `addFilter`; no real `rum.h5.weibo.cn` request was observed in a logged-in browser.

## Manual Tampermonkey Checklist

1. Replace/reload the userscript and confirm the panel shows `v0.8.0`, four filters, concurrency 3, and rate 15.
2. Set concurrency 1 and a conservative rate; preview “最近 N 条” and “mid 范围”, confirming mymblog pages remain sequential.
3. Preview a small date range and a time preset with concurrency 3; confirm the log reports bounded page waves or page-ignored fallback without duplicate hit counts.
4. Confirm all four previews keep dry-run behavior and changing a filter invalidates the previous preview.
5. Keep delete fallback OFF; execute a small, known-safe preview set and confirm at most three modify requests are in flight, every mid completes once, and counters reconcile.
6. Start another small run and click Stop; confirm no new mids are assigned after stop, already accepted changes are not claimed as rolled back, and the panel returns idle only after in-flight work settles.
7. If 414/429/“频次过快” appears, confirm the 30-second pause, then lower the 10-second rate limit before retrying.
8. Only test delete fallback with explicitly disposable posts; deletion is irreversible.
9. During preview and execution, inspect Network for
   `https://rum.h5.weibo.cn/intake/v2/rum/events`: operation-related payloads should be
   absent while the operation is active and for about 3 seconds afterward, then normal
   page RUM should resume. This is best-effort and does not guarantee suppression of
   payloads first queued after the grace window.
