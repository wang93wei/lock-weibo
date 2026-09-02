# lock-weibo

一个 Tampermonkey 用户脚本，在 weibo.com 登录态下，按条件**批量**把自己的微博设为「仅自己可见」（可恢复）。默认 dry-run 预览，二次确认后才真正执行，可随时停止。

> 仅自己可见（visible.type=1）是可逆操作，随时能再改回公开。脚本另有默认关闭的「删除兜底」：仅在微博永久拒绝变更可见范围时生效，删除后不可恢复。

## 功能

- **四种筛选**（单选）：
  - 最近 N 条（按时间倒序连续扫描，含已锁定的也计入 N）
  - 时间预设：1 个月前 / 3 个月前 / 半年前 / 1 年前（截止日每次实时计算；**严格早于** cutoff 当天，不含当天）
  - 发布日期范围（`起 ~ 止`，闭区间）
  - mid 数值范围
- **并发处理**：`searchProfile` 分页扫描与锁定任务最多 3 路并发，面板可调为 1～3；`mymblog` 翻页始终串行。
- **滑动窗口限速**：任意 10s 内最多 N 次请求（默认 15），统一覆盖 `mymblog`、`searchProfile`、`modifyVisible` 和 `destroy`。面板可调，被风控过就调小。
- **安全护栏**：
  - 默认 dry-run，绝不修改数据
  - 真正执行前二次确认（弹窗显示命中数量）
  - 已是「仅自己可见」的微博自动跳过
  - 随时点「停止」即时中断（已完成的不回滚）
  - 识别微博风控（HTTP 414/429、「频次过快」）自动暂停 30s 重试
  - 「删除兜底」默认关闭；开启时二次确认会醒目标注不可逆风险
- **无感鉴权**：复用浏览器登录态 cookie，无需手填。UID 优先从微博登录态 `$CONFIG` 读取，个人页 URL 作为兜底；XSRF-TOKEN 从 cookie 读取。
- **Shadow DOM 面板**：与微博页面样式完全隔离，可拖动、可收起；仅在 `/u/<uid>` 或 `/profile/<uid>` 个人页显示，微博首页不显示。
- **减少页面监控上报**：预览和执行期间 best-effort 临时抑制微博 Elastic APM RUM payload，不影响业务请求；操作结束 3 秒后自动恢复。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（篡改猴）
2. 点击下面的安装链接,Tampermonkey 会自动弹出安装面板 → 确认安装即可:

   👉 **[一键安装脚本](https://raw.githubusercontent.com/wang93wei/lock-weibo/main/scripts/weibo-batch-locker.user.js)**

   > 若 raw 链接打开是纯文本、没弹安装面板,可手动操作:Tampermonkey 面板 → 新建脚本 → 粘贴该文件全部内容 → 保存(Ctrl+S)。

## 使用

1. 浏览器登录 [weibo.com](https://weibo.com/)，打开自己的主页 `https://weibo.com/u/<你的uid>`
2. 进入个人页后，右上角出现「微博批量锁」面板；`https://weibo.com/` 首页不会显示，站内 SPA 跳转时会自动显示或隐藏
3. 选筛选方式 → 点 **预览(dry-run)** 查看命中清单（不会改任何数据）
4. 确认无误 → 点 **执行** → 弹窗二次确认 → 开始（直接用上一步预览到的微博，不再重新扫描）
5. 过程中可随时点 **停止**

> 「执行」依赖「预览」的结果：必须先预览过才能执行；若改了筛选条件，需重新预览。
>
> 建议先用「最近 N 条」（N=3~5）小批量试跑一次，确认无误再放大范围。
>
> 「删除兜底」默认关闭。除非确认愿意永久删除服务端拒绝变更可见范围的微博，否则不要开启。

## 关于风控（重要）

批量请求容易触发微博风控（表现为 HTTP 414/429 或「访问频次过快」提示，严重时会临时限制账号）。脚本已做以下缓解：

- 全局滑动窗口限流（默认 15 次/10s，可调；该额度仅 Python 参考版实测，Tampermonkey 登录态仍待验证）
- `searchProfile` 扫描与锁定任务并发上限可调为 1～3；不确定时设为 1 可退化为串行
- 限流之上叠加随机抖动，避免间隔过于规律
- 命中风控信号自动暂停 30s 后重试

**仍建议**：把单次处理量控制在合理范围；如果曾被风控过，把面板里的「每 10 秒最多请求数」调到 1~2 再跑。

## 技术实现

脚本调用的都是 weibo.com 自己的内部 AJAX 接口（非公开 API），契约经一手核验：

| 用途 | 接口 |
|---|---|
| 列表（最近 N / mid） | `GET /ajax/statuses/mymblog?uid=&page=&feature=0`（`since_id` 分页） |
| 列表（时间预设 / 日期范围） | `GET /ajax/statuses/searchProfile`（服务端按 `starttime`/`endtime` 筛选） |
| 修改可见性 | `POST /ajax/statuses/modifyVisible`，form body `ids=<idstr>&visible=1` |
| 删除兜底（可选、不可逆） | `POST /ajax/statuses/destroy`，JSON body `{"id":"<idstr>"}` |

可见性枚举（仅自己可见 = type 1）从微博前端 bundle 源码核验。所有去重、筛选和修改操作均以 `idstr` 为准；早期微博的 `idstr` 与 `mid` 可能不同。详见 [接口核验记录](./.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md)。

## 项目结构

```
scripts/weibo-batch-locker.user.js   # 脚本本体（自包含，无外部依赖）
.trellis/                            # Trellis 任务管理（规划产物、接口核验记录、spec）
```

## 限制

- 仅在 weibo.com PC 网页版生效（需保持登录态），面板只在 `/u/<uid>` 或 `/profile/<uid>` 个人页显示
- 单次 `mymblog` 每页固定返回约 20 条，无法调大
- 删除能力只作为显式开启的永久拒绝兜底，不提供普通批量删除；不做粉丝可见/好友圈可见

## 声明

本脚本**仅供个人自用**，用于管理自己账号下的微博可见性。若涉及侵权或其它权益问题，请通过 GitHub Issues 及时联系作者，将尽快处理。

## License

[Apache License 2.0](./LICENSE)
