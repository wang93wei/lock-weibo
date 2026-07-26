# lock-weibo

一个 Tampermonkey 用户脚本，在 weibo.com 登录态下，按条件**批量**把自己的微博设为「仅自己可见」（可恢复）。默认 dry-run 预览，二次确认后才真正执行，可随时停止。

> 仅自己可见（visible.type=1）是可逆操作，随时能再改回公开。本脚本**不会删除**微博。

## 功能

- **四种筛选**（单选）：
  - 最近 N 条
  - 时间预设：1 个月前 / 3 个月前 / 半年前 / 1 年前（截止日每次实时计算，动态锁定）
  - 发布日期范围（`起 ~ 止`，闭区间）
  - mid 数值范围
- **滑动窗口限速**：任意 10s 内最多 N 次请求（默认 3，≈每 3.3s 一次），覆盖翻页与修改请求。面板可调，被风控过就调小。
- **安全护栏**：
  - 默认 dry-run，绝不修改数据
  - 真正执行前二次确认（弹窗显示命中数量）
  - 已是「仅自己可见」的微博自动跳过
  - 随时点「停止」即时中断（已完成的不回滚）
  - 识别微博风控（HTTP 414/429、「频次过快」）自动暂停 30s 重试
- **无感鉴权**：复用浏览器登录态 cookie，无需手填。uid 从 URL 读取，XSRF-TOKEN 从 cookie 读取。
- **Shadow DOM 面板**：与微博页面样式完全隔离，可拖动、可收起。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（篡改猴）
2. Tampermonkey 面板 → 新建脚本 → 粘贴 [`scripts/weibo-batch-locker.user.js`](./scripts/weibo-batch-locker.user.js) 的全部内容 → 保存（Ctrl+S）

## 使用

1. 浏览器登录 [weibo.com](https://weibo.com/)，打开自己的主页 `https://weibo.com/u/<你的uid>`
2. 右上角出现「微博批量锁」面板
3. 选筛选方式 → 点 **🔍 预览(dry-run)** 查看命中清单（不会改任何数据）
4. 确认无误 → 点 **🔒 执行** → 弹窗二次确认 → 开始
5. 过程中可随时点 **⏹ 停止**

> 建议先用「最近 N 条」（N=3~5）小批量试跑一次，确认无误再放大范围。

## 关于风控（重要）

批量请求容易触发微博风控（表现为 HTTP 414/429 或「访问频次过快」提示，严重时会临时限制账号）。脚本已做以下缓解：

- 全局滑动窗口限流（默认 3 次/10s，可调）
- 限流之上叠加随机抖动，避免间隔过于规律
- 命中风控信号自动暂停 30s 后重试

**仍建议**：把单次处理量控制在合理范围；如果曾被风控过，把面板里的「每 10 秒最多请求数」调到 1~2 再跑。

## 技术实现

脚本调用的都是 weibo.com 自己的内部 AJAX 接口（非公开 API），契约经一手核验：

| 用途 | 接口 |
|---|---|
| 拉取微博列表 | `GET /ajax/statuses/mymblog?uid=&page=&feature=0` |
| 修改可见性 | `POST /ajax/statuses/modifyVisible`，body `ids=<mid>&visible=1` |

可见性枚举（仅自己可见 = type 1）从微博前端 bundle 源码核验。详见 [`docs`](./.trellis/tasks/07-27-weibo-batch-locker/research/weibo-api-notes.md)。

## 项目结构

```
scripts/weibo-batch-locker.user.js   # 脚本本体（自包含，无外部依赖）
.trellis/                            # Trellis 任务管理（规划产物、接口核验记录、spec）
```

## 限制

- 仅在 weibo.com PC 网页版生效（需保持登录态）
- 单次 `mymblog` 每页固定返回约 20 条，无法调大
- 不做批量删除；不做粉丝可见/好友圈可见（架构上可扩展，UI 未暴露）

## License

MIT
