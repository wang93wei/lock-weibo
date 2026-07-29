# 技术设计 — 微博批量锁脚本

## 1. 总体架构

单文件 Tampermonkey 用户脚本，模块化分节（IIFE 包裹，避免污染全局）。运行在 `weibo.com`，注入一个 Shadow DOM 浮动面板。

```
┌─ Userscript Header (@grant none, @match weibo.com/*)
└─ (async IIFE)
   ├─ Config 常量
   ├─ Util: getUid / getXsrfToken / sleep / parseWeiboDate / log
   ├─ API 层: fetchBlogPage / modifyVisible
   ├─ Filters (纯函数): byDateRange / byMidRange / byRecentN
   ├─ Executors:
   │   └─ runApiMode (分页拉取→过滤→跳过→逐条改，AbortController 中断)
   │      （点击模式已剔除，见 prd.md Out of Scope）
   ├─ UI: Shadow DOM 面板 (模式/筛选/参数/dry-run/执行/停止/日志/计数)
   └─ bootstrap
```

## 2. 接口契约（详见 research/weibo-api-notes.md，此处摘要）

| 用途 | 方法 | URL | Body / Query | 成功判定 |
|---|---|---|---|---|
| 拉取一页微博 | GET | `/ajax/statuses/mymblog` | `?uid=&page=&feature=0` (+since_id) | `ok===1` 且 `data.list` 存在 |
| 改可见性 | POST | `/ajax/statuses/modifyVisible` | `ids=<mid>&visible=1` (form) | `data.ok>0` |

请求头（两个接口都需要）：
- `x-requested-with: XMLHttpRequest`
- `x-xsrf-token: <document.cookie 里的 XSRF-TOKEN>`
- `content-type: application/x-www-form-urlencoded`（仅 POST）

## 3. 关键模块设计

### 3.1 API 层

```js
async function fetchBlogPage({uid, page, sinceId}, signal) {
  const params = new URLSearchParams({ uid, page, feature: 0 });
  if (sinceId) params.set("since_id", sinceId);
  const res = await fetch(`https://weibo.com/ajax/statuses/mymblog?${params}`, {
    headers: { "x-requested-with": "XMLHttpRequest", "x-xsrf-token": getXsrfToken() },
    credentials: "include",
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.ok !== 1) throw new Error(`API ok=${data.ok} ${data.msg||""}`);
  return data.data; // { list, total, since_id }
}

async function modifyVisible(mid, signal) {
  const body = new URLSearchParams({ ids: String(mid), visible: "1" });
  const res = await fetch("https://weibo.com/ajax/statuses/modifyVisible", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      "x-xsrf-token": getXsrfToken(),
    },
    body,
    credentials: "include",
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!(data.ok > 0)) throw new Error(`API ok=${data.ok} ${data.msg||""}`);
  return data;
}
```

### 3.2 筛选器（纯函数，可单测）

统一签名：`(blogs: Blog[], opts) => Blog[]`，输入来自 `mymblog.data.list`。

- `byDateRange(blogs, {start, end})` — `start`/`end` 为 `YYYY-MM-DD`，闭区间按天比较。内部 `parseWeiboDate(created_at)` → 比较 `YYYY-MM-DD` 字符串（避免时区坑）。
- `byMidRange(blogs, {startMid, endMid})` — `mid` 转 BigInt 比较（mid 是 16 位数字，超出 Number.MAX_SAFE_INTEGER，**必须用 BigInt 或字符串比较**——实测 `5324531386024695` 已超 `2^53`）。采用字符串比较（mid 定长递增，字典序等价数值序）。
- `byRecentN(blogs, {n})` — `mymblog` 本身按时间倒序返回，取前 n 即可；但因分页，实际是「累积到 n 条命中后停止拉取」，见 3.3。

> **mid 比较的坑**：mid 字符串长度一致（16 位），可直接字典序比较；若长度不等先按长度再按字典序。封装 `cmpMid(a,b)`。

### 3.3 API 执行器 `runApiMode`

```
状态: abortController = new AbortController()
计数: {success, skipped, failed, scanned}
流程:
  page=1, sinceId=null, collected=[]
  while not aborted:
    pageData = await fetchBlogPage({uid, page, sinceId}, signal)
    if pageData.list empty → break
    batch = filter(pageData.list)              // 应用当前筛选器
    for blog of batch:
      if aborted → break
      if blog.visible.type === 1 → skipped++, log(跳过); continue
      log(正在处理 mid ...)
      retry loop (3 次, 指数退避):
        try modifyVisible(blog.mid, signal) → success++; break
        catch AbortError → rethrow (停止)
        catch other → 退避 2^attempt 秒后重试; 最终 failed++
      await sleep(random(base*0.8, base*1.2))   // 限速
    sinceId = pageData.since_id; page++
    // 最近 N 条模式：collected 命中数达 n 后 break
  log(完成: 成功X 跳过Y 失败Z)
```

- **停止语义**：`abortController.abort()` 让进行中的 `fetch` 立即 reject（`AbortError`），执行器捕获后退出循环，不再发起新请求。已成功的不回滚。
- **dry-run 分支**：同样跑拉取+筛选+跳过判定，但**不调用 modifyVisible**，只收集命中清单渲染到面板。

### 3.4 UI 面板（Shadow DOM）

- 宿主：`document.body` 末尾插入一个 `<div id="wbl-host">`，`attachShadow({mode:"open"})`。
- 样式全部写在 Shadow 内 `<style>`，与微博隔离；可拖动、可最小化。
- 控件：
  - 模式单选：API / 点击(实验)
  - 筛选单选：日期范围 / mid 范围 / 最近 N 条（切换时显示对应输入区）
  - 延时输入（秒，默认 1.5）
  - 按钮：`预览(dry-run)` `执行` `停止` `清空日志`
  - 显示区：计数（成功/跳过/失败/已扫描）、命中预览列表、滚动日志
- 状态机：`idle → previewing → (confirmed) running → idle`；`running` 时禁用执行/预览，启用停止。

## 4. 数据流

```
用户选筛选+模式 → [预览] runApiMode(dryRun=true) → 命中清单显示
              → 用户确认 → [执行] runApiMode(dryRun=false)
              → 分页拉取 mymblog → filter → skip if type===1 → modifyVisible(mid,"1")
              → 计数/日志实时更新 → 完成 or 用户点停止
```

## 5. 安全护栏

1. **默认 dry-run**：脚本首次操作必须是预览。
2. **二次确认**：预览后点「执行」弹 `confirm("将把 N 条微博设为仅自己可见，确认？")`。
3. **停止即停**：AbortController，不拖延。
4. **限速**：默认 1.5s ±20% 随机；用户可调大。
5. **风控检测**：`ok<=0` 或 HTTP 429/403 → 暂停并在日志醒目提示，建议增大延时。
6. **cookie 失效**：`mymblog` 失败带登录提示 → 面板置灰并提示「请先登录 weibo.com」。

## 6. 兼容性与降级

- 浏览器：现代 Chrome/Edge/Firefox（需支持 Shadow DOM、AbortController、fetch、URLSearchParams、BigInt）。
- `@grant none`：纯页面上下文，`fetch` 同源最省事。若未来 cookie 变 HttpOnly，切 `@grant GM_cookie` 读 XSRF。
- 接口失效：若 `modifyVisible` 被下线/改参，回到 `research/` 重新抓包；必要时再启用点击模式子任务。

## 7. 测试策略

- **纯函数单测**（node_repl）：三个筛选器、`parseWeiboDate`、`cmpMid`、`getXsrfToken`（mock document.cookie）、`isPrivate`(visible.type===1)。
- **语法**：`node --check scripts/weibo-batch-locker.user.js`。
- **集成**（人工，需登录态）：dry-run 预览三种筛选 → 「最近 3 条」真实试跑 → 确认 type 变 1。
