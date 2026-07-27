# Implement: fix-batch-locker-bugs

## File

- `scripts/weibo-batch-locker.user.js` only

## Checklist

1. Fix `byRecentN` / `runApiMode` recent stop: page-level continuous scan; stop when `stats.hits.length >= n`
2. Fix `modifyVisible` error code branching (RISK vs other)
3. Align before-months UI text to「早于 cutoff」
4. Re-read uid in `doPreview` / `doRun` via `getUid()`
5. Clear resets `lastPreview`
6. After successful lock, mark hit `isPrivate = true`
7. `isPrivate` coerce type with `Number(...) === 1` or `== 1` carefully
8. Bump version 0.6.0 → 0.6.1 (header + panel)

## Validate

- Re-read changed sections for logic consistency
- No build/test commands available
