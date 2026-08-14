# 安全说明

- Microsoft/Google Client Secret、MSAL/Google Token Cache、Delta Link、Gmail History ID、Webhook Secret 和 TOTP Secret 使用实例主密钥加密保存。
- 邮箱密码从不进入系统。
- 管理员密码使用 Argon2id；会话使用 Secure/HttpOnly/SameSite Cookie 与 CSRF Token。
- 备份口令不保存，忘记后无法恢复。
- 请将 `.env` 权限保持为 `0600`，不得提交到版本库。
- 生产环境必须通过受信任反向代理提供 HTTPS，并限制只有反向代理能访问本地 `127.0.0.1:8080`。
- 若怀疑实例主密钥泄漏，应立即撤销 Microsoft 与 Google 应用许可、轮换 Client Secret 和 Webhook Secret，并重建实例。
