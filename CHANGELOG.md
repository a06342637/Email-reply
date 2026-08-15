# 更新日志

## v0.12 - 2026-08-16

- 系统设置新增“告警记录”独立保留周期；处理日志、系统日志、已恢复告警和审计日志现在可分别配置 1–3650 天，Worker 每天自动删除超期记录。
- 告警清理仅删除已经恢复的历史记录，未处理和已确认的活动告警始终保留；同时清理对应 Webhook Outbox，避免残留投递任务。
- “系统设置 → Microsoft”与“添加 Microsoft 邮箱”弹窗新增完整 Entra 配置清单，明确账户类型、Web 回调、六项委托范围、管理员同意、Client Secret Value，以及禁止选择应用程序权限。
- Client ID + Refresh Token 导入说明新增公共客户端、同一 Client ID、`offline_access` 和 Graph 委托权限要求，并明确 Secret 型 confidential client 应改用 OAuth 网页登录。
- “系统设置 → Google / Gmail”与新增的 Gmail 连接说明弹窗补充 Gmail API、OAuth 同意屏幕、External/Internal、Test users、Web 客户端、回调地址、受限权限和 Testing Token 有效期说明。
- README、UI 冒烟数据和自动化测试同步更新；版本升级为 v0.12（npm 0.0.12）。

## v0.11 - 2026-08-16

- 修复 Buildx 在只读 updater 容器中首次创建 `/root/.docker` 失败的问题；Docker 配置和 Buildx 状态现在固定写入 `/tmp/docker` 内存盘。
- 在 Debian ARM64 上验证该故障会在服务切换前安全停止，并确认自动回滚可恢复 Git、`APP_VERSION` 和运行服务到 v0.08。
- 新增 updater 容器打包回归测试，持续检查 Buildx 包、可写 Docker 配置目录和 `/tmp` tmpfs 配置没有缺失。

## v0.10 - 2026-08-16

- 将镜像构建版本与 updater 运行版本从旧容器的 `APP_VERSION` 中解耦，改用内部 `BUILD_APP_VERSION` 和 `UPDATER_APP_VERSION`，避免旧环境变量覆盖目标版本。
- 新 Compose 文件带有目标版本默认值，因此从存在旧版本变量问题的 v0.08/v0.09 升级时即可自动生成正确的镜像标签和 updater 版本，无需等待下一次升级自愈。
- Compose 子进程仍显式注入三个版本变量，兼顾升级、回滚和 updater 自刷新场景的一致性。

## v0.09 - 2026-08-16

- 修复 updater 容器继承旧 `APP_VERSION` 后覆盖项目 `.env` 中目标版本的问题；所有 Compose 子进程现在显式使用当前目标版本。
- updater 自刷新 helper 显式传入目标版本，升级完成后的 updater 健康接口、容器环境和镜像标签将与应用版本保持一致。
- 新增版本环境优先级回归测试，防止后续升级再次出现“应用已升级但镜像/updater 仍显示旧版本”的情况。

## v0.08 - 2026-08-16

- 在 Debian ARM64 生产服务器完成 v0.06 → v0.07 的真实在线升级验收，确认加密备份、镜像保留、迁移、服务切换、版本健康检查、状态持久化和 updater 自刷新链路可用。
- updater 镜像加入 Docker Buildx 插件，消除 Compose 回退到传统构建器的兼容性隐患，并为后续在线升级保留现代构建链路。
- 生产验收确认 IP 端口与 HTTPS 域名健康检查均返回目标版本，原暂停任务、已发送处理记录和数据库持久卷在升级后保持不变。

## v0.07 - 2026-08-16

- 在“系统设置 → 在线升级”加入正式版本检查、更新内容展示、升级确认、实时阶段进度、过程记录和重启后自动重连。
- 新增独立 updater 容器；升级任务不依赖 app 存活，后台重启期间仍会继续构建、迁移、启动和健康检查。
- 在线升级只接受固定 GitHub 官方仓库 main 分支上的正式版本标签，并校验远程地址、分支、工作区、快进历史、标签和 VERSION 一致性，阻止误升级、降级和覆盖本地改动。
- 每次升级前要求输入独立备份口令并生成加密 `.mpbak`；口令不写入数据库、状态文件、审计日志或 Docker 日志。
- 升级前保留当前 app/worker 镜像，失败时自动恢复旧代码、APP_VERSION 和服务镜像；数据库不兼容时保留升级前备份供管理员恢复。
- updater 不映射公网端口，使用独立 Docker 网络和随机内部 Bearer Token；worker 无法访问升级网络且不会获得升级密钥。
- updater 自身在应用升级成功后由独立临时容器安全刷新，升级进度通过持久卷跨容器重启保存。
- install.sh 自动生成 PROJECT_DIR 与升级内部密钥，并同时检查 updater 健康状态；update.sh 改为正式标签升级并加强代码、环境和镜像回滚。
- 新增在线升级版本解析、官方仓库规范化、dotenv 更新、敏感输出脱敏和内部 API 鉴权回归测试。

## v0.06 - 2026-08-15

- 修复 Microsoft Graph 附件列表在基础 `attachment` 类型上选择派生字段 `contentId`，导致所有 Microsoft 自动回复在发送前失败的问题。
- 无固定附件的模板现在跳过不必要的附件恢复查询；有附件时仅选择 Graph 基础附件类型支持的 `name`、`size`、`contentType` 与 `isInline` 字段。
- 修复 Microsoft 模板测试发送时向 Graph JSON 草稿写入非 `X-` 自定义邮件头而被拒绝的问题。
- 修复 Microsoft Graph 要求 Open Extension 展开必须带过滤条件，导致已发送状态核验失败的问题；核验现在直接使用持久化的实例追踪邮件头。
- 已发送状态改为事务条件认领，并发核验只允许一次状态落库和一条成功日志，同时继续保证不会重复发送邮件。
- Client ID + Refresh Token 导入现在会单独识别缺少 Microsoft Graph 授权的旧 Outlook Token，并提示重新授予 `User.Read`、`Mail.ReadWrite`、`Mail.Send`。
- 增加无附件快速路径和附件恢复查询字段回归测试，防止同类 OData 查询兼容性问题再次出现。

## v0.05 - 2026-08-15

- 修复 Nest 通配符中间件使用 `req.path` 被裁剪为 `/` 的问题；认证现在始终从 `originalUrl` 判断 API 路由。
- 修复首次登录改密接口返回 500 的问题，并阻止未登录请求绕过认证访问后台 API。
- 增加认证中间件路由回归测试，覆盖反代、查询参数、健康检查和首次改密路径。
- 将未配置环境变量时的 `TRUST_PROXY` 默认值改为 `0`，避免公网直连时错误信任伪造的转发请求头。

## v0.04 - 2026-08-15

- Docker Compose 和 Debian 安装脚本默认将后台端口绑定到 `0.0.0.0:8080`，安装后可直接通过 `http://服务器IP:8080` 访问。
- 安装完成信息会显示检测到的服务器 IP、访问端口和本机健康检查地址。
- IP 直连默认使用空 `PUBLIC_URL` 和 `TRUST_PROXY=0`，避免 HTTPS Cookie 阻止登录，并防止公网客户端伪造转发 IP；配置本机反向代理时再显式启用一层代理信任。
- README 与安全文档补充 IP 直连、主机防火墙、HTTPS 反向代理和 OAuth 回调限制说明。
- 保留容器内部健康检查、开发环境回退地址与 Nginx 本机上游的回环地址，避免扩大数据库、Redis 或内部服务的暴露范围。

## v0.03 - 2026-08-15

- Microsoft 邮箱新增两种授权入口：OAuth 网页登录（推荐）与 Client ID + Refresh Token 高级导入。
- 高级导入会先通过 Microsoft v2 Token Endpoint 换取 Access Token，校验 User.Read、Mail.ReadWrite、Mail.Send，读取 `/me`，并实际验证 inbox 与 junkemail 可读；任一步失败都不会写入邮箱。
- 新增每邮箱 Microsoft 授权模式和独立 Client ID；系统级 Microsoft Client ID/Secret 变更只影响 MSAL OAuth 邮箱，不会误停手工导入邮箱。
- 独立 Refresh Token、轮换后的 Refresh Token 和短期 Access Token 使用实例主密钥加密保存；后台不回显 Refresh Token，审计日志不记录 Token。
- Microsoft Graph 遇到 401 时先强制刷新一次令牌；无关的 `ErrorAccessDenied` 403 不再误判为授权失效。
- 授权失效更新加入 Token Cache 条件竞争保护，旧 Refresh Token 的迟到失败不会覆盖管理员刚导入的新凭据；凭据已变化时会自动改用最新缓存重试。
- 修复发送状态核验期间授权失效可能过早进入 `UNCERTAIN` 的问题；未发送草稿与待核验发送会保留，重新授权并恢复任务后继续安全核验。
- OAuth 重新连接可将手工导入邮箱安全切回 MSAL；高级导入也可更新现有 Microsoft 邮箱，同时保留任务、游标和历史去重数据。
- 已移除邮箱允许在 Microsoft 与 Gmail 之间重新绑定；活动邮箱仍禁止跨提供商覆盖，Google 重连时会清理遗留的 Microsoft 授权模式字段。
- 备份恢复新增 Microsoft 授权模式兼容校验，并继续兼容没有该字段的 v0.01/v0.02 备份。
- 后台新增 Microsoft 双方式连接弹窗、推荐标记、授权方式与独立 Client ID 展示，并补充完整安全说明和故障排查教程。
- 增加 Refresh Token 轮换、权限缺失、撤销授权、401 强制刷新、并发凭据替换、MSAL Cache 无变化跳过写入、发送核验恢复、非授权 403、跨提供商重连、系统配置隔离、OAuth 模式切换和备份兼容测试；当前共 23 个测试文件、89 项后端测试。

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

后续版本按 `v0.02`、`v0.03`、`v0.04` 的方式递增；内部 npm 包使用等价的合法 SemVer 版本号。
