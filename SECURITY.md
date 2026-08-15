# 安全说明

- v0.05 修复了通配符认证中间件导致 API 请求未执行认证的问题；升级后请重新登录并确认后台接口未登录时返回 401。
- Microsoft/Google Client Secret、MSAL/Google Token Cache、Delta Link、Gmail History ID、Webhook Secret 和 TOTP Secret 使用实例主密钥加密保存。
- 邮箱密码从不进入系统。
- 管理员密码使用 Argon2id；会话使用 Secure/HttpOnly/SameSite Cookie 与 CSRF Token。
- 备份口令不保存，忘记后无法恢复。
- v0.07 的 updater 是唯一挂载 Docker Socket 的容器，不映射宿主机端口，并与 worker 隔离在不同 Docker 网络。Docker Socket 等同宿主机高权限，请勿自行把 updater 端口发布到公网，也不要把 `UPDATER_TOKEN` 提供给第三方。
- 在线升级只接受固定官方仓库 main 分支上的正式版本标签，并拒绝脏工作区、分支错误、标签与 VERSION 不一致、非快进和降级操作。升级前备份口令只在任务内存中使用。
- 请将 `.env` 权限保持为 `0600`，不得提交到版本库。
- v0.04 起 app 默认绑定宿主机 `0.0.0.0:8080`，便于首次安装后通过服务器 IP 和端口访问。该入口是明文 HTTP，请使用主机防火墙或云安全组限制可信来源，并尽快配置 HTTPS。
- IP 直连模式默认设置 `TRUST_PROXY=0`，不得在 8080 仍直接暴露公网时盲目信任客户端提交的转发 IP 请求头。
- Microsoft 与 Google OAuth 回调必须使用受信任的 HTTPS 域名，不能使用普通 HTTP IP 地址。
- 配置 Nginx、Caddy 或宝塔反向代理后，建议在 `.env` 中将 `HOST_BIND` 改为 `127.0.0.1`、将 `TRUST_PROXY` 改为 `1`，然后重建 app 容器，使 8080 只供本机反向代理访问。
- 若怀疑实例主密钥泄漏，应立即撤销 Microsoft 与 Google 应用许可、轮换 Client Secret 和 Webhook Secret，并重建实例。
