# Implement — per-endpoint throttle buckets

## Checklist（按序）

1. [ ] CONFIG：新增 `RATE_MAX_SEARCH=15`、`RATE_MAX_TIMELINE=8`、`RATE_MAX_WRITE=10`、`MYMBLOG_MIN_GAP_MS=900`、`MYMBLOG_DEEP_PAGE=300`、`MYMBLOG_DEEP_EXTRA_MS=600`、`PAGE_RISK_WAITS_MS=[30000,60000,120000]`；保留 `RATE_WINDOW_MS/RATE_LIMITED_WAIT_MS` 语义供 search/写复用。
2. [ ] 限流器实例：`searchLimiter / timelineLimiter / writeLimiter = createRateLimiter(...)`；删除（或停用）全局 `rateLimiter`，全仓确认无残留 `rateLimiter.` 引用。
3. [ ] 接入点：`fetchSearchProfilePage`→search 桶；`fetchBlogPage`→timeline 桶 + 页间隙 sleep（含深页追加，`signal` 透传）；`modifyVisible`/`requestDestroy`→write 桶。
4. [ ] 退避：`mymblog` 补扫 RISK 等待改为渐进序列 + 抖动；耗尽后置 `stats.incomplete/resumeMpage` 并返回部分结果；`doPreview` 存快照 + 中断提示日志。
5. [ ] 面板：HTML 新增 `wbl-rate-timeline` 输入行并重命名既有为 `wbl-rate-search`；更新 `readRuntimeCfg/logRuntimeCfg/hint`；clamp 回写；运行时禁用逻辑覆盖新输入。
6. [ ] 版本：header `0.8.4` + 面板 `<small>v0.8.4</small>` 同步。
7. [ ] 静态验证：`node --check scripts/weibo-batch-locker.user.js`；`git diff --check`；全仓 `grep rateLimiter` 确认 3 桶各自命中且无旁路 fetch。
8. [ ] 受控行为检查（Node VM harness 或同等）：并发 1/3、page 忽略/生效、RISK 渐进等待、中断保留部分预览、二次执行不重复处理。
9. [ ] 真实页面验证（登录态，低额度先行）：时间预设 dry-run 看 `mymblog` 间隔拉开且无连续 414；执行小批量看写桶独立；Stop/AUTH 在途收尾；结论追加 API notes。

## Validation commands

```bash
python ./.trellis/scripts/task.py validate 09-12-per-endpoint-throttle
node --check scripts/weibo-batch-locker.user.js
git diff --check
```

登录态手工（Tampermonkey 重载后，`/u/<uid>` 个人页）：
- 时间预设 3 个月 dry-run：Network 过滤 `mymblog` 看间隔 ≥ ~1s、深页无连续 414；过滤 `searchProfile` 看波次速度不受拖累。
- 并发 1 与 3 各跑一次 Stop：在途收尾后回 idle。
- 小批量真实锁定（已知安全微博）：二次确认、预览复用、`sameFilterCfg` 变化阻止旧预览执行。

## Risky files / rollback points

- 唯一产品文件：`scripts/weibo-batch-locker.user.js`（限流器定义、4 处 acquire、补扫循环、面板 HTML/配置读取、版本号）。
- 回滚：`git checkout -- scripts/weibo-batch-locker.user.js`；规划产物保留在 `.trellis/tasks/09-12-per-endpoint-throttle/` 不受影响。

## Gates before `task.py start`

- [ ] `prd.md` + `design.md` + `implement.md` 已复核（复杂任务缺一不可）。
- [ ] `implement.jsonl` / `check.jsonl` 各 ≥1 条真实条目（seed 行已删或自动忽略）。
- [ ] 用户已明确批准本轮最终规划总结（另起消息，口头“可以开工”即算数；改动后需重新评审）。
