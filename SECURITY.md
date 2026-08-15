# 安全说明

- v0.05 修复了通配符认证中间件导致 API 请求未执行认证的问题；升级后请重新登录并确认后台接口未登录时返回 401。
- Microsoft/Google Client Secret、MSAL/Google Token Cache、Delta Link、Gmail History ID、Webhook Secret 和 TOTP Secret 使用实例主密钥加密保存。
- 邮箱密码从不进入系统。
- 管理员密码使用 Argon2id；会话使用 Secure/HttpOnly/SameSite Cookie 与 CSRF Token。
- 备份口令不保存，忘记后无法恢复。
- 请将 `.env` 权限保持为 `0600`，不得提交到版本库。
- v0.04 起 app 默认绑定宿主机 `0.0.0.0:8080`，便于首次安装后通过服务器 IP 和端口访问。该入口是明文 HTTP，请使用主机防火墙或云安全组限制可信来源，并尽快配置 HTTPS。
- IP 直连模式默认设置 `TRUST_PROXY=0`，不得在 8080 仍直接暴露公网时盲目信任客户端提交的转发 IP 请求头。
- Microsoft 与 Google OAuth 回调必须使用受信任的 HTTPS 域名，不能使用普通 HTTP IP 地址。
- 配置 Nginx、Caddy 或宝塔反向代理后，建议在 `.env` 中将 `HOST_BIND` 改为 `127.0.0.1`、将 `TRUST_PROXY` 改为 `1`，然后重建 app 容器，使 8080 只供本机反向代理访问。
- 若怀疑实例主密钥泄漏，应立即撤销 Microsoft 与 Google 应用许可、轮换 Client Secret 和 Webhook Secret，并重建实例。
