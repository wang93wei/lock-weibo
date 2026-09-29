# 仅在自己的微博主页显示面板

## Goal
修复访问其他人的微博主页也显示批量锁定面板。

## Background
- `scripts/weibo-batch-locker.user.js:2310` 的 isProfilePage 仅检查数字个人页路径，`:2321` 用它决定面板显隐。
- `:160` 的 getUid 在登录配置缺失时回退页面 UID，不能直接用作所有权证明。
- 当前 Chrome 已确认登录配置 UID 可用；首页现有 v0.8.4 面板处于隐藏状态。

## Requirements
- R1：仅在 /u/<uid> 或 /profile/<uid> 的 UID 与可信登录配置一致时显示；他人主页及首页隐藏。
- R2：无法确认登录 UID 时不显示；不得用 URL 回退证明登录身份。
- R3：保留 pushState、replaceState、popstate 的 SPA 显隐；隐藏保留原面板状态。
- R4：不改变业务 API、扫描、写操作、限流；版本标记保持同步。
- R5：用户补充要求将 @match 收窄到 https://weibo.com/u/* 和 https://weibo.com/profile/*，保留本人身份门禁。用户已知首次从首页 SPA 进入个人页可能需要刷新。

## Acceptance Criteria
- 元数据仅匹配两类个人页路径；首次从非匹配页进入而未加载脚本时，刷新个人页后再验证。
- 两种自己的个人页路径显示；他人主页、首页、无效路径、登录配置缺失或无效时不显示。
- 自己→他人→自己 SPA 切换隐藏并恢复，面板不重复创建。
- 受控行为检查覆盖路由、登录 UID 来源及 SPA；语法和补丁检查通过。
- 当前 Chrome 登录态验证自己与他人主页及 SPA 往返，不执行微博写操作。

## Scope and Delivery
轻量缺陷修复，PRD-only。用户已授权修复及创建任务。无阻塞产品决策；不包含提交、push、真实锁定、取消快转或删除。

## Validation Result (2026-09-29)
- 主代理在 Chrome 真实登录态复现旧版问题：他人主页与登录 UID 不一致时，v0.8.4 面板仍显示。
- 受控 Node VM 检查通过：两类本人路径、他人/首页/无效路径、登录配置缺失或无效、登录 UID 来源、SPA pushState/replaceState/popstate 及面板单实例。
- v0.8.6 语法、补丁空白、两条精确 @match 与双版本一致性检查通过，独立检查代理未发现问题。
- 用户自行更新脚本并反馈“试完了，没问题”，随后授权提交至远程。新版真实页面通过为用户反馈，非代理独立完整端到端取证；未执行微博锁定、删除或取消快转。
