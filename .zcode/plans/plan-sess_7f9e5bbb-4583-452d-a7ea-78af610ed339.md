## 微博批量锁脚本 — 最终实施计划

> 所有关键接口契约已用**一手证据**核验（在你的账号实测 + 从微博前端 bundle 源码挖出真实调用），不再是二手猜测。

### 核验结论（将写入 research 文档防丢失）
- **列表**：`GET /ajax/statuses/mymblog?uid={uid}&page={n}&feature=0` → `{ok:1, data:{list[], total, since_id}}`，每条含 `id`(数字)/`mid`(字符串)/`visible:{type,list_id}`/`created_at`
- **锁定**：`POST /ajax/statuses/modifyVisible`，body `{ids: <mid>, visible: "1"}`（visible 是**字符串**），成功 `{ok:>0}`
- **仅自己可见 type = 1**（前端菜单 `modify2My` 与发博选择器双重印证一致）
- **visible 字段是对象**，跳过逻辑判 `blog.visible.type === 1`
- **鉴权**：同源 fetch + `credentials:include` 自动带 cookie；`XSRF-TOKEN` 经 `document.cookie` 读取（实测可读），放 `x-xsrf-token` 头
- **created_at**：`"Sat Jul 25 11:37:50 +0800 2026"`，`Date.parse` 可解析
- **记录的二手信息出入**：WeiBoHideTool 好友圈=2 与现网部分不符，但仅自己可见=1 一致，不影响本任务

### 已确认需求
- 锁 = 仅自己可见（type 1，可恢复）
- 筛选三选一：发布日期范围 / mid 数值范围 / 最近 N 条
- 执行二选一：API 直调 / 模拟点击
- 自动跳过已是仅自己可见
- 随时停止
- 走 Trellis 任务流程

### 文件结构
```
scripts/weibo-batch-locker.user.js            # 主脚本（自包含，中文 UI，英文注释）
.trellis/tasks/MM-DD-weibo-batch-locker/
  task.json  prd.md  design.md  implement.md
  research/weibo-api-notes.md                 # 一手接口核验记录
  implement.jsonl  check.jsonl                # 指向 research + guides
```

### 脚本模块（单文件分节）
1. **Userscript 头**：`@grant none`、`@match https://weibo.com/*`、`@run-at document-idle`
2. **Config**：默认延时(~1.5s 随机)、PAGE_SIZE=20、重试 3 次
3. **API 层**：`getUid()`(从 URL)、`getXsrfToken()`(读 cookie)、`fetchBlogPage(uid,page,since_id)`、`modifyVisible(mid, signal)`
4. **筛选器（纯函数）**：`byDateRange`/`byMidRange`/`byRecentN`，统一吃 `blog[]` 吐 `blog[]`
5. **API 执行器**：分页拉取→筛选→跳过 `visible.type===1`→逐条 `modifyVisible`，`AbortController` 中断、随机延时、指数退避重试、计数器(成功/跳过/失败)
6. **点击执行器（best-effort 兜底）**：滚动加载 + 点 ●●● → 「转换为自己可见」
7. **UI**：Shadow DOM 浮动面板，含模式选择、筛选切换、参数输入、延时设置、dry-run 预览、执行、停止、滚动日志、计数
8. **护栏**：默认 dry-run；真执行前二次确认列命中数；限速可配；cookie 失效明确提示

### 安全/降级
- 默认 dry-run 先预览命中清单
- 真执行需二次确认
- 停止按钮经 AbortController 即时中断
- 风控响应(`ok<=0`)自动退避并在日志提示
- 点击模式标 best-effort，仅 API 失效时兜底

### 执行步骤（Trellis 流程）
1. `task.py create "微博批量锁脚本" --slug weibo-batch-locker`
2. 写 `prd.md` / `design.md` / `implement.md` / `research/weibo-api-notes.md`
3. 整理 `implement.jsonl` / `check.jsonl`（指向 research + `.trellis/spec/guides/`，JS spec 为空）
4. **呈现 review → 你通过后** `task.py start`（status→in_progress）
5. 写 `scripts/weibo-batch-locker.user.js`
6. 质量检查：`node --check` 语法；纯函数(筛选器/日期解析/xsrf 解析)在 node_repl 单测；人工 review 接口参数与护栏
7. Phase 3.3：把 `modifyVisible`/`mymblog` 接口契约写进 `.trellis/spec/`
8. Phase 3.4：按中文 commit 风格提交，不 push

### 验证策略
- CLI 能做：`node --check`、纯函数单测
- 真实联调：你在浏览器装脚本后用 dry-run 预览 + 「最近 3 条」少量试跑（未经你确认对具体微博触发真实锁定）

### MVP 边界（不做）
- 不做批量删除；不做粉丝/好友圈可见（架构上 visible 可扩展，UI 不暴露）
- 点击模式不保证选择器长期稳定
- 不自动更新 cookie
