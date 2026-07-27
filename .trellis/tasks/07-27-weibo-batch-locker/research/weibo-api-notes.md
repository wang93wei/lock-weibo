# 微博可见性接口 — 一手核验记录

> 本文档记录的是 **2026-07-27 在登录态浏览器实测 + 从微博前端 bundle 源码挖出**的接口契约，非第三方仓库的二手描述。若接口未来变动，以重新抓包为准。

## 核验账号

- 在一个登录态的个人主页（`weibo.com/u/<uid>`）实测，账号身份已脱敏。
- 前端 bundle：`https://h5.sinaimg.cn/m/weibo-pro-next/assets/index-BLM88guT.js`（weibo-pro-next 单页应用主 chunk，约 6.8MB）

## 1. 列表接口 mymblog（已实测）

**请求**
```
GET https://weibo.com/ajax/statuses/mymblog?uid={uid}&page={n}&feature=0
Header: x-requested-with: XMLHttpRequest
```
- 同源 fetch + `credentials:"include"` 自动带 cookie，无需额外鉴权头即可成功。

**实测响应结构**（HTTP 200，数值已脱敏为示例）
```jsonc
{
  "ok": 1,
  "data": {
    "since_id": 5312956372879279,   // 分页游标，下一页带上（示例值）
    "total": 8219,                  // 该账号微博总数（示例值）
    "status_visible": ...,
    "list": [ /* 每页 20 条 */ ]
  }
}
```

**单条微博关键字段**（实测首条 `id=5324531386024695`）
```jsonc
{
  "id": 5324531386024695,            // 数字
  "idstr": "5324531386024695",       // 字符串，与 id 同值
  "mid": "5324531386024695",         // 字符串，与 id 同值
  "mblogid": "...",                  // bid 形式短链 ID（如 RaiaKphiv）
  "visible": { "type": 0, "list_id": 0 },   // ⚠️ 是对象，不是数字
  "created_at": "Sat Jul 25 11:37:50 +0800 2026",  // Date.parse 可解析
  "text_raw": "...",                 // 纯文本正文
  "source": "来自 Xiaomi 17 Pro Max"
}
```

**分页**：用 `since_id` 游标（page 也递增）。`list` 为空表示到底。

## 2. 可见性枚举（从 bundle 源码挖出，权威）

### 2.1 修改菜单构造（bundle pos ~4069769）
微博前端「●●●」菜单按当前 `visible.type r` 动态插入转换项，调用 `this.modifyVisible("<字符串>")`：

| 菜单文案 | key | 传给 modifyVisible 的值 | 触发条件（当前 type 不等于） |
|---|---|---|---|
| 转换为公开 | `modify2Open` | `"0"` | `r!==0 && r!==9` |
| 转换为粉丝可见 | `modify2Fans` | `"10"` | `r!==10 && r!==9` |
| 转换为好友圈可见 | `modify2Friends` | `"2"` | `r!==6 && r!==9` |
| 转换为付费会员可见 | `modify2Vmenber` | `"3"` | `r!==9`（且 isVmenber===1）|
| **转换为自己可见（仅自己可见）** | `modify2My` | `"1"` | `r!==1 && r!==9` |
| 删除 | — | — | — |

> ⚠️ 注意 `modify2Friends`（好友圈）调用 `modifyVisible("2")`，但发博选择器里好友圈标注为 `visible:6`（见 2.2）。菜单传值 "2" 与列表 `type:6` 存在不一致——疑似前端历史遗留。**本任务只用「仅自己可见 = 1」，菜单传 "1" 与列表 type 1 两处完全一致，不受此矛盾影响。**

### 2.2 发博可见性选择器（bundle visibleList，pos ~附近）
```js
visibleList: [
  { visible: 0,  text: "公开" },
  { visible: 10, text: "粉丝" },
  { visible: 6,  text: "好友圈" },
  { visible: 1,  text: "仅自己可见" },   // ← 目标
  { visible: 5,  text: "群可见" }
]
```

### 2.3 结论枚举表（本任务采用）

| type | 含义 | 本任务是否使用 |
|---|---|---|
| 0 | 公开 | — |
| 1 | **仅自己可见** | ✅ 锁定目标值 |
| 5 | 群可见 | — |
| 6 | 好友圈（列表字段） | — |
| 9 | 某种受限态（菜单对其隐藏所有转换项）| — |
| 10 | 粉丝可见 | — |
| 3 | 付费会员可见 | — |

## 3. 锁定接口 modifyVisible（从 bundle 源码挖出确切调用）

**bundle 源码（pos ~4080031），微博前端真实实现：**
```js
getModifyVisibleApi(n) {
  this.$http.post("/ajax/statuses/modifyVisible", {
    ids: this.id,        // 单条微博 id
    visible: n           // 字符串："0"/"1"/"2"/"3"/"10"
  }).then(r => {
    if (r.data && r.data.ok > 0) {
      const o = r.data;
      if (o.statuses && o.statuses.length && o.statuses[0]) {
        // 更新前端状态
      }
    }
  });
}

modifyVisible(n) {
  const r = this.visible.type;
  let o = "";
  // 友好圈/粉丝圈转公开需二次确认；付费会员可见不可逆需确认
  [10, 6].includes(r) && n === "0" ? o = "微博中的评论、点赞等信息也将变为公开，是否确认？"
    : n === "3" && (o = "设为付费粉丝可见后，分享范围不可再次修改，是否确认？");
  // ...确认后调用 getModifyVisibleApi(n)
}
```

**本任务调用契约**
```
POST https://weibo.com/ajax/statuses/modifyVisible
Content-Type: application/x-www-form-urlencoded   (或 JSON，见下注意)
Header: x-xsrf-token: <XSRF-TOKEN cookie 值>
Header: x-requested-with: XMLHttpRequest
Body: ids=<mid>&visible=1
```
- 成功响应：`{ "ok": <>0, "statuses": [...] }`
- **`visible` 值用字符串 `"1"`**（前端源码如此）。`ids` 是单个 mid。
- ⚠️ 前端用 axios POST JSON，但 WeiBoHideTool 的 Python 实现用 `application/x-www-form-urlencoded` 表单 `ids=<mid>&visible=1`（数字）也能成功。**两个编码都验证过可工作**；脚本采用表单编码（与 `Content-Type: application/x-www-form-urlencoded` 配 `ids`/`visible` 字段），更接近 RESTful 习惯且实测路径已被验证。

## 4. 鉴权

- **同源 cookie**：脚本运行在 `weibo.com`，`fetch(url, {credentials:"include"})` 自动携带全部 cookie（含 `SUB`/`SUBP`/`SSOLoginState` 等）。**无需手填 cookie。**
- **XSRF-TOKEN**：实测 `document.cookie` 可读到 `XSRF-TOKEN`（**非 HttpOnly**，24 字符）。需放入请求头 `x-xsrf-token`。
  - 解析：`document.cookie.match(/XSRF-TOKEN=([^;]+)/)[1]` → `decodeURIComponent`。
  - 若未来变 HttpOnly，降级为 `GM_cookie.list`（需 `@grant GM_cookie`）。
- **cookie 失效判定**：`mymblog` 返回 403 / `ok:0` 且 `msg` 含登录相关 → 提示重新登录。

## 5. 关键陷阱与决策

1. **`visible` 是对象不是数字**：跳过逻辑必须判 `blog.visible.type === 1`，不能写 `blog.visible === 1`。
2. **`visible` 请求值是字符串**：传 `"1"` 而非 `1`（与前端一致，保险）。
3. **好友圈枚举矛盾**（2.1 注释），本任务避开。
4. **限速 / 风控**（实测 2026-07-27，重要）：
   - dry-run 扫描时若 `mymblog` 分页**连发**（无间隔），约 12 页后触发微博风控。
   - 风控信号：HTTP **414**（微博网关挪用此码表示"请求过多"，**不是**真正的 URI Too Long——单次 mymblog URL 仅 ~100 字符）、HTTP **429**、或响应体含「访问频次过快 / 频繁」文案。
   - 风控判定依据是**短时间内的请求密度**（窗口内次数），而非单次间隔——因为微博前端自己翻页是滚动触发、无固定间隔，不存在"官方正常间隔"。
   - 应对：**全局滑动窗口限流器**（任意 10s 内最多 3 次请求，≈每 3.3s 一次），覆盖 `mymblog` + `modifyVisible`；之上叠加小幅随机抖动避免规律性；命中风控信号后暂停 30s 再重试。窗口次数可在面板调整。
   - 单次 `mymblog` 每页固定返回 ~20 条，**无法用参数增大**（PC web 端写死）。扫描一年（约 240 条）需翻 ~12 页，按默认限速约需 40s。
5. **不可逆操作**：仅自己可见可恢复（type 1 ↔ 0 可双向），但付费会员可见（3）不可逆——本任务只做 1，安全。

## 6. searchProfile — 服务端按时间筛选接口（实测 2026-07-27）

微博前端「按发布时间筛选」走的是 `searchProfile`，可由服务端按 `starttime`/`endtime`
（Unix 秒，**+0800 本地时区语义**）直接过滤，**无需客户端逐页拉取再过滤**。对"时间预设/
日期范围"场景，比 `mymblog` 全量分页省一两个数量级的请求配额。

**请求**
```
GET https://weibo.com/ajax/statuses/searchProfile
  ?uid=<uid>
  &page=1                 # ⚠️ 实测恒为 1，page 参数被忽略（见下「分页」）
  &endtime=<unix秒>       # 含，+0800 时区；推进游标靠缩小它
  [&starttime=<unix秒>]   # 可选，省略 = 不设下界（实测可工作）
  [&hasori=1&hasret=1&hastext=1&haspic=1&hasvideo=1&hasmusic=1]
Header: x-requested-with: XMLHttpRequest
Header: x-xsrf-token: <XSRF-TOKEN>
  Header: referer: https://weibo.com/u/<uid>     # ⚠️ 服务端校验，缺失则 403
                                                  #   userscript 同源 fetch 时浏览器自动发送，无需手动设
```

**`has*` 参数（可选）**：内容类型筛选器（原创/转发/纯文本/图/视频/音乐）。
**与可见性无关**——实测同时间窗去掉全部 `has*`，结果完全一致（含 type=1 私有微博）。
纯时间筛选时全部省略，URL 更短。

**实测响应结构**（窗口 2024-09-22 一天内，账号含 1 条 type=1 私有微博）
```jsonc
{
  "ok": 1,
  "data": {
    "list": [ /* 与 mymblog 单条结构相同：id/idstr/mid/mblogid/visible{type,list_id}/created_at/text_raw/... */ ],
    "total": 6,        // 窗口命中总数（示例；total==0 表示窗口内无微博）
    "absstr": "..."    // 时间筛选的展示用字符串，无关
    // ⚠️ 无 since_id 字段
  }
}
```

**分页（实测，重要，反直觉）**：接口排序为**新→旧**，单页固定返回 **50 条**
（不是 mymblog 的 20）。窗口内微博超过 50 条时，**`page`、`max_id`、`since_id`
三个参数全部被服务端忽略**——实测对同一宽窗口（uid=1238726882，2025 H1，total=134）
分别请求 `page=1/2/3`、`&max_id=<最旧mid>`、`&since_id=<最旧mid>`，六次返回的
50 条 mid 序列**逐字节相同**，`total` 也基本不变。

→ **唯一能推进游标的是缩小 `endtime`**：取本页**最旧一条**的 `created_at`
转 Unix 秒，作为下一页的 `endtime`，`page` 恒为 1，循环直到取空。
- 同秒碰撞兜底：维护 `seenMids = new Set()`，若某页**无任何新 mid**（全是已见过的）
则判定到底，避免 `endtime` 停在同一秒导致死循环。
- 终止条件三选一：`list.length === 0`、本页无新 mid、或达 `MAX_PAGES_FALLBACK` 上限。

**可见性覆盖（关键，实测）**：`searchProfile` **能搜出 type=1「仅自己可见」的微博**
（mid=5081417737047965 实测命中）。对"批量锁定"场景完全可用——既不会漏掉已私有的（
重复锁定会被脚本跳过），也能精准命中窗口内所有待锁微博。

**风控差异（实测，关键）**：`searchProfile` 比 `mymblog` 严——服务端**校验 `Referer` 头**。
矩阵实测（同 uid/时间窗/cookie，仅变 header 组合）：

| Referer | User-Agent | Cookies | 结果 |
|---|---|---|---|
| ✗ | ✓ | ✓ | **403 `{"error":"Forbidden"}`** |
| ✓ | ✗ | ✓ | **200 OK**（返回完整 list） |
| ✗ | ✗ | ✓ | **403 Forbidden** |
| ✓ | ✓ | ✗ | 200 但 `ok:-100`（重定向登录）|

→ 决定性的是 **`Referer`**，有无 `User-Agent` 无所谓。`mymblog` 不做此校验。
**对脚本无影响**：脚本运行在 `weibo.com/u/<uid>` 页面，同源 `fetch` 时浏览器**自动**发送
`Referer: https://weibo.com/u/<uid>`（Referer 是 forbidden header，无法手动设，但默认值
正是服务端要的）。故代码侧与 `fetchBlogPage` 完全一致（只带 `x-xsrf-token` +
`x-requested-with`），无需额外处理。仍走全局滑动窗口限流器。
注意若用户把面板拖到非 `/u/<uid>` 页（如首页），Referer 可能不达标 → 403；脚本应在
`getUid()` 取不到时已提示用户回到 `/u/<uid>`。

**Unix 时间戳换算**：`starttime`/`endtime` 是 +0800 本地时区的 Unix 秒。
JS：`Math.floor(localDate.getTime()/1000)`（`Date.parse` 已按本地时区解析）。
- 用户选「日期范围」`start..end`：`starttime = start 00:00:00`，
  `endtime = end 23:59:59`（含当天，避免丢当日晚间的微博）。
- 用户选「时间预设 N 个月」：`endtime = (今天 - N 月) 00:00:00`，
  `starttime` 省略（不设下界）。

## 7. 参考资料

- 微博客服「微博可见性变更功能相关问题」https://kefu.weibo.com/faqdetail?id=21092
- 第三方实现（部分描述与现网不符，仅供对照）https://github.com/ByteRax/WeiBoHideTool
- m.weibo.cn 非官方 API 整理 https://gist.github.com/zmwangx/64af488ca4eed04d8a719c7293e2f0a1
