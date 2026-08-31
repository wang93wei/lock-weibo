# Implementation Plan

## 1. 配置与面板

- [x] 将默认请求额度改为 15 次/10 秒，新增默认并发数 3 与 searchProfile 单窗口页数常量。
- [x] 在面板加入并发输入（1~3），更新限速输入为 1~15，并在操作开始前 clamp/回写。
- [x] 每次预览/执行读取并校验运行参数，记录并发与窗口额度日志。

## 2. 有界并发基础能力

- [x] 实现固定 worker 数的任务消费 helper；只有 AUTH 是池级 fatal，Abort 停止全部 worker，其他失败保留逐项语义。
- [x] 使用 `Promise.allSettled` 或等价机制等待全部已启动 worker 收尾，不产生未等待 Promise。

## 3. searchProfile 页波次并发

- [x] 让 `fetchSearchProfilePage` 接收 page 参数并更新已过期注释。
- [x] 把单页 endtime 循环改为“窗口轮次 → 有界页波次”，每页保留分类重试。
- [x] 按页码顺序合并结果，游标取本轮全部原始返回项的最旧时间，保持 `seenMids`、unique scanned、含边界同秒组与 fallback 语义。
- [x] 比较首波多页 id 序列；检测 page 被忽略后，本次扫描后续轮次自动退回 page=1。
- [x] 保持 `mymblog` 最近 N/mid 和深历史补扫串行。

## 4. 锁定 worker 池

- [x] 将 `lockByIds` 的串行循环改为最多 N 个 worker 并发。
- [x] 保持单条 AUTH/RISK/API/PERM/destroy 处理、`item.isPrivate` 回写与统计对账。
- [x] AUTH 停止领取新任务并等待已在途任务，Abort 中止全部 worker；其余失败不升级为池级 fatal。

## 5. 兼容与版本

- [x] 保留四种筛选、dry-run、预览复用、二次确认、停止、UID/SPA 与删除默认关闭。
- [x] 同步更新头部与面板版本到 0.8.0。
- [x] 更新关键注释和用户日志，说明有界并发及顺序可能乱序。

## 5.5 操作期间 RUM 抑制

- [x] 实现一次性 `elasticApm.addFilter` 注册、活跃操作计数和 3 秒恢复宽限；缺失 APM 时 no-op。
- [x] 在预览扫描和真实执行的最外层 `finally` 释放抑制，覆盖成功、AUTH、Abort 和异常退出。
- [x] 不改写 Fetch/XHR，不调用 APM 私有字段，不改变四个业务接口与限流器。
- [x] 用临时受控 harness 验证 filter once、操作期丢弃、宽限恢复、重叠操作与 no-op。

## 6. Verification Gate

- [x] 运行 `node --check scripts/weibo-batch-locker.user.js`。
- [x] 搜索并人工核对所有 `fetch` 前的全局 limiter、并发上限和四条 endpoint。
- [x] 核对 searchProfile 不使用 `data.total`、不以短页终止、游标含边界推进。
- [x] 核对 15 次/10 秒只标为 Python 已测、userscript 待真实验证；命中 RISK 可调低并保持 30 秒暂停。
- [x] 核对 `@version` 与面板版本一致。
- [x] 检查 Git diff 仅包含任务产物、授权 userscript 与必要 spec 更新，保留用户其他修改。
- [x] 输出 Tampermonkey 四种筛选与少量执行的人工验证清单；没有真实验证就明确说明。

## Rollback Points

- searchProfile 波次异常：并发设为 1 可临时退化；必要时仅回退页波次循环。
- 执行 worker 异常：并发设为 1 可临时退化；必要时仅回退 `lockByIds` 消费方式。
- 不回滚已验证的 API contract、idstr、错误分类、预览复用或删除保护。
