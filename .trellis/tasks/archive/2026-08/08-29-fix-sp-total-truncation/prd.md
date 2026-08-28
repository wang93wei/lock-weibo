# 修复 searchProfile total 饱和导致时间范围扫描提前截断

## 背景（2026-08-29 实测诊断）

用户用「时间预设 → 1 年前 (12个月)」扫描时，扫描在 ~1000 条附近提前结束，
更早的历史微博完全没进预览。

根因：`runApiModeSearchProfile` 用首个响应的 `data.total` 做「已达服务端总数」
提前终止（`stats.hits.length >= serverTotal` → break）。但实测 searchProfile 的
`total` 在大窗口下是**饱和近似值（~1000±10）**，不是窗口内真实命中数：

- cutoff 窗口（2025-08-29 之前）服务端报 `total=1007`（另一次探测 1010，数值抖动）。
- 从同一起点按相同游标走法实测收集 **1242 条**唯一 mid 仍未到底（游标已到 2021-05）。
- 直接反证：窗口「截止 2025-03-01」实际仅返回 47 条（< 单页 50 = 窗口真实总数），
  `total` 却报 1007 —— total 与窗口内容脱钩。
- 深历史（2019-2020）返回正常，不是索引深度问题。

次要发现（同次修复）：游标推进 `nextEnd = oldestEpoch - 1`（不含边界）时，
若 50 条分页边界恰好落在同一秒发布的多条微博中间，余下同秒帖子既不在本段
也不在下段，会被静默跳过。

## Requirements

1. **去掉对 `data.total` 的信任**：删除 `serverTotal` 捕获与 `hits >= total` 早停。
   现有终止条件已足够：空列表、本段无新 mid（newCount===0）、`MAX_PAGES_FALLBACK`。
   代价仅是多一次收尾请求，正确性优先。
2. **游标推进改为含边界**：`curEnd = oldestEpoch`（不再 -1），依赖 `seenMids` 去重。
   同秒余下帖子会在下一段被取回；全见过的段由 newCount===0 终止，不会死循环。
   `starttime` 下界判断保持 `nextEnd < starttime` 才停（nextEnd == starttime 时继续，
   以覆盖起点秒上被分页边界切开的同秒组）。
3. **同步修正研究笔记** `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md`
   第 6 节：「优先用 data.total 收尾」与「游标必须 oldestEpoch - 1」两条结论按
   2026-08-29 实测改写，注明证据。
4. **版本号双处 0.6.6 → 0.6.7**：`// @version` 头 + `BUILD_PANEL_HTML` 内 `<small>`。

## Acceptance Criteria

- [ ] `runApiModeSearchProfile` 中不再引用 `serverTotal` / `pageData.total`；
      「已达服务端总数」日志分支删除。
- [ ] 游标推进为含边界 + seenMids 去重；同秒组在分页边界被切开时不丢帖（代码走查可证）。
- [ ] 终止条件覆盖：空段、无新 mid、下界 starttime、`MAX_PAGES_FALLBACK`、用户停止。
- [ ] `node --check scripts/weibo-batch-locker.user.js` 通过。
- [ ] `@version` 与面板 `<small>` 版本一致（0.6.7）。
- [ ] API 笔记第 6 节结论与实测一致并注明日期。

## 不做（Out of scope）

- mymblog 路径（`runApiMode`）不变。
- 不新增「搜索索引可能缺帖」类对账逻辑（mymblog 交叉校验），留作后续任务。
- 不改限流策略、UI 结构。
