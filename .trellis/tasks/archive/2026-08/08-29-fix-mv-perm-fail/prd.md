# 修复 modifyVisible 400 永久失败被误重试

## 背景（2026-08-29 用户实测反馈）

执行锁定时，部分微博 `POST /ajax/statuses/modifyVisible` 返回 **HTTP 400**，
响应体 `{"ok":0,"message":"此条微博暂不支持变更可见范围。"}`（注意字段是
`message` 不是 `msg`）。这类是**永久性业务拒绝**（该微博类型不支持改可见范围），
重试必然失败。

现状缺陷（scripts/weibo-batch-locker.user.js）：

- `modifyVisible` 第 445 行对非 2xx 只抛 `modifyVisible HTTP 400`，**不读响应体**、
  不打错误码（真实原因丢失）。
- 两个调用方（`runApiMode` 约 703 行、`lockByIds` 约 963 行）的重试循环对无
  AUTH/RISK 码的错误走指数退避重试，共 `MAX_RETRY=3` 次 → 每条这种微博
  白烧 3 个请求 + 2 轮退避等待（用户截图：同一 mid 连发 3 个 POST 400）。
- 另：JSON 路径（HTTP 200 + ok<=0）只读 `data.msg`，若该措辞以 200 返回也
  读不到 `message` 字段。

## Requirements

1. `modifyVisible` 非 2xx 时尝试读响应体 JSON（容错：非 JSON 保持通用错误文案）；
   `message`/`msg` 命中「暂不支持」措辞 → 抛错带 `e.code = "PERM"`。
2. `data.ok <= 0` 的 JSON 路径同步识别「暂不支持」→ `PERM`；读取字段兼容
   `message` 与 `msg`。
3. 两个重试循环增加 `PERM` 分支：记 1 次失败、日志说明「不支持变更，不重试」、
   立即 break（等价现状的 RISK 最大重试分支的收尾方式）。
4. API 笔记第 3 节（modifyVisible）补充该永久失败契约：HTTP 400 + `ok:0` +
   `message` 字段名 + 「暂不支持变更可见范围」措辞，注明 2026-08-29 实测。
5. **出错时在浏览器控制台（调试窗口）输出正确错误信息**：`modifyVisible` 的两个
   失败点（非 2xx、ok<=0）在抛错前 `console.error` 输出 `[wbl]` 前缀 + mid +
   HTTP 状态（或 ok 值）+ 服务端 message 原文；无可解析响应体时也要有可读输出。
   面板日志继续保留。
6. 版本号双处 0.6.7 → 0.6.8（`@version` + `BUILD_PANEL_HTML` `<small>`）。

## Acceptance Criteria

- [ ] `modifyVisible` 对 400 + 「暂不支持变更可见范围」抛 `PERM` 码错误，
      错误文案含服务端 `message` 原文；响应体非 JSON 时回退通用文案、无异常抛出。
- [ ] 两个失败点抛错前均有 `console.error`（`[wbl]` 前缀 + mid + 状态/ok + 服务端
      message），DevTools 控制台可直接看到失败原因。
- [ ] 两个重试循环遇 `PERM` 不重试：单条微博只发 1 次 POST，`stats.failed` 计 1。
- [ ] RISK / AUTH / 通用指数退避路径行为不变。
- [ ] `node --check scripts/weibo-batch-locker.user.js` 通过。
- [ ] `@version` 与 `<small>` 均为 0.6.8。
- [ ] API 笔记第 3 节含新契约并注明实测日期。

## 不做（Out of scope）

- 不改限流策略、扫描逻辑、UI。
- 不猜测「暂不支持」的具体微博类型清单（服务端语义，记录现象即可）。
