# 更新日志

## v0.02 - 2026-08-15

- 新增 Gmail 个人邮箱和 Google Workspace 用户邮箱支持。
- 新增 Google OAuth 2.0 Authorization Code + PKCE、加密 Refresh Token、Gmail API 配置页和连接/重新授权流程。
- 使用 Gmail History API 检测 INBOX 与 SPAM；支持首次基线、暂停恢复补处理、History ID 失效重扫、分页游标持久化和数据库去重。
- 新增 Gmail RFC 5322 MIME 回复草稿、HTML/纯文本、内嵌图片、固定附件、threadId/In-Reply-To/References 会话关联和发送状态核验。
- 抽象邮件提供商轮询与发信路由，使 Microsoft Graph 和 Gmail 共用规则、模板、队列、日志、防循环与防重复状态机。
- 备份恢复新增 Google 应用配置、可迁移 Token Cache 和 Gmail History 游标，同时兼容 v0.01 备份。
- 后台新增 Google/Gmail 设置标签、双提供商连接入口、提供商与同步状态展示，并统一邮件服务文案。
- 修复 Gmail 分页令牌过期恢复、非授权类 403 调度、跨提供商事务去重和 Gmail 会话绑定失败的安全降级路径。
- 增加 Gmail OAuth、权限完整性、Token 刷新、History/SPAM 映射、分页恢复窗口、MIME 附件、无盲重试发送和旧备份兼容测试；当前共 23 个测试文件、71 项后端测试。

## v0.01 - 2026-08-14

- 首个公开版本。
- 支持 Outlook/Hotmail 个人邮箱和全球版 Microsoft 365 用户邮箱。
- 支持收件箱与垃圾箱增量检测、规则匹配、Liquid 模板、附件和防重复回复。
- 提供 Docker Compose、Debian 12/13 安装脚本、管理后台、日志告警、备份恢复与升级回滚。
- 增加 From 与 Reply-To 分离处理，避免服务邮件通过外部回复地址绕过安全过滤。
- 增强草稿创建、附件上传、发送超时和授权恢复状态机，避免可确认的重复回复。
- 增加站点名称与时区即时生效、TOTP 后台关闭、三态主题和手机导航滚动锁。
- 增加 PostgreSQL、Redis、Worker 就绪检查和 Worker 启动告警宽限。
- 增强设置事务校验、备份一致性快照、升级前流式下载和版本自动同步。
- 完成第二轮可靠性审计，修复 Delta 200 页边界与分页游标回退漏信、任务暂停竞态、发送阶段数据库异常核验、中断邮件运行时恢复、附件非幂等重试、Webhook 多端点重复投递与租约竞态、Outbox 误清理，以及登录失败计数和 TOTP 恢复码的并发问题。
- 补齐 ESLint 和 GitHub Actions Linux/Docker 冒烟流水线，并通过 53 项后端自动化测试、类型检查、生产构建、Prisma/YAML 校验、完整 Docker Compose 健康与运维 CLI 验证，以及桌面和移动端 UI 冒烟测试。

后续版本按 `v0.02`、`v0.03` 的方式递增；内部 npm 包使用等价的合法 SemVer 版本号。
