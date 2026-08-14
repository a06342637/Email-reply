import { useState } from "react";
import { Eye, EyeOff, LockKeyhole, MailCheck } from "lucide-react";
import { api, json } from "../api";
import type { Admin } from "../types";

export function LoginPage({ onLogin }: { onLogin: (admin: Admin) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api<{ admin: Admin }>(
        "/api/v1/auth/login",
        json("POST", { username, password, totpCode: totpCode || undefined }),
      );
      onLogin(result.admin);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-glow" />
      <div className="login-brand">
        <div className="brand-mark large">
          <MailCheck />
        </div>
        <h1>MailPilot</h1>
        <p>Microsoft 与 Gmail 邮箱自动回复控制台</p>
      </div>
      <form className="login-card" onSubmit={submit}>
        <div>
          <span className="eyebrow">安全登录</span>
          <h2>欢迎回来</h2>
          <p>输入管理员凭据以继续管理邮箱任务。</p>
        </div>
        {error && <div className="form-error">{error}</div>}
        <label>
          管理员用户名
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <div className="password-field">
            <input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <button
              type="button"
              aria-label={show ? "隐藏密码" : "显示密码"}
              onClick={() => setShow(!show)}
            >
              {show ? <EyeOff /> : <Eye />}
            </button>
          </div>
        </label>
        <label>
          双重验证码 <small>未启用可留空</small>
          <input
            inputMode="numeric"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
            placeholder="6 位验证码或恢复码"
          />
        </label>
        <button className="primary wide" disabled={loading}>
          <LockKeyhole size={18} />
          {loading ? "正在验证…" : "登录控制台"}
        </button>
        <footer>会话使用安全 Cookie、CSRF 防护和登录限速</footer>
      </form>
    </div>
  );
}
