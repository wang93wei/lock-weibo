# Journal - alan (Part 1)

> AI development session journal
> Started: 2026-07-27

---



## Session 1: 修复批量锁脚本审查缺陷

**Date**: 2026-07-28
**Task**: 修复批量锁脚本审查缺陷
**Branch**: `main`

### Summary

修复最近N跨页漏扫、searchProfile分页/计数、待锁语义、modifyVisible错误码；请求头对齐window.\；v0.6.5

### Git Commits

| Hash | Message |
|------|---------|
| `93773cd` | (see git log) |

### Status

[OK] **Completed**

---

## Session 2: 修复 SPA 路由后 UID 未刷新

**Date**: 2026-07-29
**Task**: 07-29-uid-spa-refresh
**Branch**: `main`

### Summary

- 归档遗留任务 `07-27-weibo-batch-locker`、`00-bootstrap-guidelines`
- `getUid()` 优先 `$CONFIG.uid`；`onSpaNavigate` 刷新面板 UID
- v0.6.6；AGENTS / frontend quality-guidelines / API 笔记路径同步

### Status

[OK] **Completed**


## Session 2: 修复 searchProfile total 饱和导致的扫描截断

**Date**: 2026-08-29
**Task**: 修复 searchProfile total 饱和导致的扫描截断
**Branch**: `main`

### Summary

实测确认 searchProfile data.total 大窗口饱和(~1000±10)不可信，删除 total 早停；游标改含边界推进+seenMids 去重修复同秒组丢帖；同步修正 API 笔记第 6 节、quality-guidelines spec 与 AGENTS.md(版本记载 0.6.7+终止约定)。检查全过，待用户 Tampermonkey 重载复扫验证。

### Git Commits

| Hash | Message |
|------|---------|
| `615c343` | (see git log) |

### Status

[OK] **Completed**


## Session 3: modifyVisible 永久失败 PERM 不重试 + 控制台报错

**Date**: 2026-08-29
**Task**: modifyVisible 永久失败 PERM 不重试 + 控制台报错
**Branch**: `main`

### Summary

实测 modifyVisible 400+message「暂不支持变更可见范围」为永久拒绝：modifyVisible 读响应体(兼容 message/msg)标 PERM，两条路径(runApiMode/lockByIds)遇 PERM 单次失败不重试；两失败点 console.error([wbl]前缀+mid+状态+原文)便于 DevTools 调试；版本 0.6.8 双处；API 笔记第 3 节、quality-guidelines、AGENTS.md 同步。检查 8/8 通过。

### Git Commits

| Hash | Message |
|------|---------|
| `2841165` | (see git log) |

### Status

[OK] **Completed**


## Session 4: 微博批量锁 v0.8.0 并发与 RUM 抑制

**Date**: 2026-09-01
**Task**: 微博批量锁 v0.8.0 并发与 RUM 抑制
**Branch**: `main`

### Summary

完成 searchProfile 有界页波次、锁定 worker 池、统一 15/10s 滑窗、destroy 瞬时错误重试及操作期 Elastic APM RUM best-effort 抑制；静态与临时 Node VM 验证通过，真实 Tampermonkey/微博 API/RUM 网络仍待人工验证。

### Git Commits

| Hash | Message |
|------|---------|
| `9ec441e` | (see git log) |

### Status

[OK] **Completed**


## Session 5: mymblog与searchProfile分桶限流 v0.8.4

**Date**: 2026-09-12
**Task**: mymblog与searchProfile分桶限流 v0.8.4
**Branch**: `main`

### Summary

单桶15/10s拆为search15/mymblog8+页间隙/写固定10三桶，mymblog退避渐进30s→60s→120s+断点保留，面板双输入；白天深页400+实测0限流，结论记入API notes §11

### Git Commits

| Hash | Message |
|------|---------|
| `13d2bb5` | (see git log) |

### Status

[OK] **Completed**


## Session 6: 微博面板仅本人主页显示及匹配范围收窄
<!-- trellis-session: v=2 fp=5246c59c09f83b66 -->

**Date**: 2026-09-29
**Task**: 微博面板仅本人主页显示及匹配范围收窄
**Branch**: `main`

### Summary

独立验证登录 UID 与个人页 UID，仅在本人主页显示面板；@match 收窄为 /u/*、/profile/*，版本 0.8.6。用户自行安装测试通过并授权推送。

### Main Changes

- 收紧面板身份门禁，保留 SPA 面板状态；同步使用说明和约束。

### Git Commits

| Hash | Message |
|------|---------|
| `a072693b2160d3fb5233f54b81a6690e6b043736` | fix(panel): 仅在登录账号自己的主页显示面板 |

### Testing

- [OK] 语法、补丁、受控 Node VM 路由和 SPA 行为检查通过；独立审查通过。新版浏览器通过来自用户反馈，未执行微博写操作。

### Status

[OK] **Completed**
