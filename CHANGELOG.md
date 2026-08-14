# 更新日志

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
- 补齐 ESLint 和 GitHub Actions Linux/Docker 冒烟流水线，并通过 40 项后端自动化测试、类型检查、生产构建、Prisma/YAML 校验、完整 Docker Compose 健康与运维 CLI 验证，以及本地 UI 冒烟测试。

后续版本按 `v0.02`、`v0.03` 的方式递增；内部 npm 包使用等价的合法 SemVer 版本号。
