# 执行计划 — 微博批量锁脚本

## 前置（已完成）

- [x] 接口一手核验 → `research/weibo-api-notes.md`
- [x] 需求 → `prd.md`
- [x] 技术设计 → `design.md`

## 实现步骤

### Step 1 — 脚手架与 Userscript 头
- [ ] 创建 `scripts/weibo-batch-locker.user.js`
- [ ] Userscript metadata：`@name`、`@namespace`、`@version 0.1.0`、`@match https://weibo.com/*`、`@grant none`、`@run-at document-idle`、`@description`
- [ ] IIFE 包裹 + `'use strict'`
- [ ] 验证：`node --check` 通过

### Step 2 — Config 与 Util
- [ ] `CONFIG`：`PAGE_SIZE`、`DEFAULT_DELAY`、`MAX_RETRY`、`RETRY_BASE_WAIT`
- [ ] `getUid()`：从 `location.pathname` 解析 `/u/<id>` 或 `/profile/<id>`，fallback 空
- [ ] `getXsrfToken()`：读 `document.cookie` 的 `XSRF-TOKEN`，`decodeURIComponent`
- [ ] `parseWeiboDate(s)`：`new Date(Date.parse(s))`，提供 `.toISOString().slice(0,10)` 便捷
- [ ] `cmpMid(a,b)`：定长字典序比较（长度不等先比长度）
- [ ] `isPrivate(blog)`：`blog.visible && blog.visible.type === 1`
- [ ] `sleep(ms, signal)`：可被 AbortSignal 中断的延时
- [ ] `randomDelay(base)`：`base * (0.8 + 0.4*random)` 秒

### Step 3 — API 层
- [ ] `fetchBlogPage({uid, page, sinceId}, signal)`（见 design 3.1）
- [ ] `modifyVisible(mid, signal)`
- [ ] 统一错误：HTTP 非 2xx、`ok` 非 1/>0、AbortError 透传

### Step 4 — 筛选器（纯函数）
- [ ] `byDateRange(blogs, {start, end})`：按天闭区间
- [ ] `byMidRange(blogs, {startMid, endMid})`：cmpMid 闭区间
- [ ] `byRecentN(blogs, {n})`：`slice(0, n)`（配合执行器的「累积到 n 即停」）
- [ ] `applyFilter(blogs, filterCfg)`：按 filterCfg.type 分发

### Step 5 — API 执行器
- [ ] `runApiMode({uid, filterCfg, dryRun, delaySec, onLog, onProgress, signal})`
  - 分页拉取 → applyFilter → isPrivate 跳过 → (非 dryRun) modifyVisible 重试退避 → 限速
  - 最近 N 条：累积命中达 n 停止拉取
  - 全程响应 `signal` abort
- [ ] 返回统计 `{success, skipped, failed, scanned, hits}`

### Step 6 — UI 面板（Shadow DOM）
- [ ] `createPanel()`：建 host + shadow root + style + DOM 结构
- [ ] 控件：模式单选、筛选单选 + 对应输入、延时输入、预览/执行/停止/清空日志按钮
- [ ] 显示区：计数、命中预览列表、滚动日志（自动滚到底）
- [ ] 状态机绑定：`idle/previewing/running` 下按钮可用性
- [ ] 可拖动 + 最小化
- [ ] bootstrap：`document-idle` 后注入

### Step 7 — 联动与护栏
- [ ] 预览：调 `runApiMode({dryRun:true})`，命中渲染到列表
- [ ] 执行：`confirm()` 二次确认 → `runApiMode({dryRun:false})`
- [ ] 停止：`abortController.abort()`，按钮即时生效
- [ ] 风控/cookie 失效：日志醒目提示

## 验证命令

```bash
# 语法
node --check scripts/weibo-batch-locker.user.js

# 纯函数单测（在 node_repl 里把脚本的核心函数抽出测试，或单独 .test.js）
# - parseWeiboDate: "Sat Jul 25 11:37:50 +0800 2026" → 2026-07-25
# - cmpMid: 5324531386024695 < 5324531386024696 (超 Number.MAX_SAFE_INTEGER)
# - byDateRange / byMidRange / byRecentN 用样本数据验证
# - getXsrfToken: mock document.cookie
# - isPrivate: {visible:{type:1}} → true; {visible:{type:0}} → false
```

## 人工集成验证（需登录态浏览器）

1. 在 Tampermonkey 安装脚本。
2. 打开 `weibo.com/u/<自身uid>`，确认面板出现且不被微博样式破坏（AC1）。
3. 三种筛选各 dry-run 一次，核对命中清单（AC2、AC6）。
4. 选「最近 3 条」→ 确认 → 真实执行 → 回页面刷新确认这 3 条 `visible.type` 变 1（AC3）。
5. 再执行一次同样「最近 3 条」→ 确认全部被跳过（AC4）。
6. 执行较大批次时点「停止」→ 确认即时停止（AC5）。
7. （点击模式已剔除，跳过 AC9。）

## 回退点

- 接口字段/枚举变动 → 回到 `research/` 重新抓包，更新枚举表与跳过判定。
- Shadow DOM 注入被微博 CSP 拦 → 降级为普通 div + 高 z-index + CSS 重置。
- cookie 变 HttpOnly → 切 `@grant GM_cookie`。
- 接口/选择器失效 → 回 research 重新抓包，必要时重启点击模式子任务。
