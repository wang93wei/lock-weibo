# 修复批量锁脚本审出的明确 bug

## Goal

修复 `scripts/weibo-batch-locker.user.js` 代码审查与实机验证中确认的缺陷，并对齐官方请求头。

## Requirements

### 已完成

1. **最近 N 条跨页漏扫** — 连续扫描，`remaining` 截取；停于 `hits.length >= n`
2. **modifyVisible 错误码** — RISK / AUTH / API 三分
3. **时间预设文案** — 「早于 cutoff」，与 endtime 语义一致
4. **SPA UID** — 预览/执行前 `getUid()`
5. **清空重置 lastPreview**
6. **执行成功** — `item.isPrivate = true`
7. **isPrivate** — `Number(type) === 1`
8. **最近 N 已扫描** — 只计实际走过的条数（非整页 20）
9. **searchProfile 分页** — 认 `data.total` 收尾；游标 `oldest-1`；已扫描只计 unique mid
10. **待锁计数** — UI「待锁」= 非 type=1；跳过日志降噪
11. **请求头对齐** — accept / client-version / server-version（`window.$VERSION`）/ traceparent

## Acceptance Criteria

- [x] 「最近 N 条」跨页连续，已扫描≈N，待锁为未锁定数
- [x] modifyVisible 错误码分支正确
- [x] 时间预设「早于 cutoff」
- [x] SPA 重读 UID；清空清预览；锁成功更新快照
- [x] searchProfile 不再多请求边界重复条；已扫描=unique
- [x] 请求头与 weibo-pro-next 对齐（$VERSION 动态）
- [x] 版本 0.6.5（header + 面板）

## Notes

- 验证：Tampermonkey + Chrome DevTools 实机
- 版本演进本任务：0.6.0 → 0.6.5
