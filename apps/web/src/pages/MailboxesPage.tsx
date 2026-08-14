import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  CirclePause,
  FileKey2,
  KeyRound,
  LogIn,
  MailPlus,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, json } from "../api";
import { useApp } from "../app-context";
import type { Mailbox } from "../types";
import {
  Card,
  Empty,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Status,
  fmtDate,
} from "../ui";
export function MailboxesPage() {
  const { notify } = useApp();
  const [data, setData] = useState<Mailbox[]>();
  const [microsoftDialog, setMicrosoftDialog] = useState(false);
  const [refreshImport, setRefreshImport] = useState({
    clientId: "",
    refreshToken: "",
  });
  const [importing, setImporting] = useState(false);
  const load = useCallback(async () => {
    setData(await api("/api/v1/mailboxes"));
  }, []);
  useEffect(() => {
    void load();
    const params = new URLSearchParams(location.search);
    const oauth = params.get("oauth");
    const provider = params.get("provider");
    const providerName = provider === "google" ? "Gmail" : "Microsoft";
    if (oauth === "success") notify(`${providerName} 邮箱已连接`);
    if (oauth === "error")
      notify(params.get("reason") || `${providerName} 授权失败`, "danger");
    if (oauth) history.replaceState({}, "", location.pathname);
  }, [load, notify]);
  async function connectOAuth(provider: "microsoft" | "google") {
    try {
      const r = await api<{ authorizationUrl: string }>(
        `/api/v1/${provider}/oauth/start`,
        json("POST", { redirectAfter: "/mailboxes" }),
      );
      location.href = r.authorizationUrl;
    } catch (e) {
      notify(e instanceof Error ? e.message : "无法连接", "danger");
    }
  }
  function openMicrosoft(mailbox?: Mailbox) {
    setRefreshImport({
      clientId: mailbox?.microsoftClientId || "",
      refreshToken: "",
    });
    setMicrosoftDialog(true);
  }
  function closeMicrosoft() {
    if (importing) return;
    setMicrosoftDialog(false);
    setRefreshImport({ clientId: "", refreshToken: "" });
  }
  async function importMicrosoftRefreshToken(event: React.FormEvent) {
    event.preventDefault();
    setImporting(true);
    try {
      const result = await api<{ email: string }>(
        "/api/v1/microsoft/import-refresh-token",
        json("POST", refreshImport),
      );
      setMicrosoftDialog(false);
      setRefreshImport({ clientId: "", refreshToken: "" });
      notify(`${result.email} 已通过 Refresh Token 安全导入`);
      await load();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Microsoft 邮箱导入失败",
        "danger",
      );
    } finally {
      setImporting(false);
    }
  }
  async function act(id: string, action: string) {
    if (
      action === "remove" &&
      !confirm(
        "移除邮箱会删除本地授权缓存、游标和任务配置，历史日志仍按保留周期保存。若需彻底撤销授权，还应到 Microsoft/Entra 或 Google 账户安全页面撤销应用许可。确定继续？",
      )
    )
      return;
    const path =
      action === "remove"
        ? `/api/v1/mailboxes/${id}`
        : `/api/v1/mailboxes/${id}/${action}`;
    await api(path, json(action === "remove" ? "DELETE" : "POST"));
    notify("操作已完成");
    await load();
  }
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="邮箱账号"
        description="Microsoft 支持 OAuth 登录或 Client ID + Refresh Token 导入；Gmail 使用 OAuth。系统不保存邮箱密码。"
        actions={
          <div className="provider-connect-actions">
            <button className="primary" onClick={() => openMicrosoft()}>
              <MailPlus size={18} />
              添加 Microsoft
            </button>
            <button onClick={() => connectOAuth("google")}>
              <MailPlus size={18} />
              连接 Gmail
            </button>
          </div>
        }
      />
      <div className="provider-permissions">
        <div className="info-strip">
          <KeyRound />
          <div>
            <strong>Microsoft 委托权限</strong>
            <span>
              OAuth 登录（推荐）或 Client ID + Refresh Token；均验证
              User.Read、Mail.ReadWrite、Mail.Send
            </span>
          </div>
        </div>
        <div className="info-strip">
          <KeyRound />
          <div>
            <strong>Google OAuth 权限</strong>
            <span>openid、email、profile、gmail.readonly、gmail.compose</span>
          </div>
        </div>
      </div>
      {data.length ? (
        <div className="mailbox-grid">
          {data.map((m) => (
            <Card key={m.id} className="mailbox-card">
              <div className="mailbox-title">
                <div className="mail-avatar">
                  {m.displayName.slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <h2>{m.displayName}</h2>
                  <p>
                    {m.email} ·{" "}
                    {m.provider === "GOOGLE" ? "Gmail" : "Microsoft"}
                  </p>
                </div>
                <Status value={m.status} />
              </div>
              <dl>
                <div>
                  <dt>{m.provider === "GOOGLE" ? "提供商" : "租户"}</dt>
                  <dd>
                    {m.provider === "GOOGLE"
                      ? "Google Gmail API"
                      : m.tenantId || "个人 Microsoft 账户"}
                  </dd>
                </div>
                <div>
                  <dt>账户类型</dt>
                  <dd>
                    {m.accountType === "GMAIL_PERSONAL"
                      ? "Gmail 个人邮箱"
                      : m.accountType === "GOOGLE_WORKSPACE"
                        ? "Google Workspace 邮箱"
                        : m.accountType === "PERSONAL"
                          ? "Outlook / Hotmail 个人邮箱"
                          : m.accountType === "MICROSOFT_365"
                            ? "Microsoft 365 用户邮箱"
                            : "未知"}
                  </dd>
                </div>
                {m.provider === "MICROSOFT" && (
                  <div>
                    <dt>授权方式</dt>
                    <dd>
                      {m.microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN"
                        ? "Client ID + Refresh Token"
                        : "OAuth 登录（推荐）"}
                    </dd>
                  </div>
                )}
                {m.provider === "MICROSOFT" && m.microsoftClientId && (
                  <div>
                    <dt>独立 Client ID</dt>
                    <dd className="break-value">{m.microsoftClientId}</dd>
                  </div>
                )}
                <div>
                  <dt>最后刷新</dt>
                  <dd>{fmtDate(m.lastTokenRefreshAt)}</dd>
                </div>
                <div>
                  <dt>
                    {m.provider === "GOOGLE" ? "History 游标" : "收件箱游标"}
                  </dt>
                  <dd>
                    {fmtDate(
                      m.provider === "GOOGLE"
                        ? m.gmailCursor?.lastSuccessfulAt
                        : m.cursors.find((c) => c.folder === "INBOX")
                            ?.lastSuccessfulAt,
                    )}
                  </dd>
                </div>
                {m.provider === "MICROSOFT" && (
                  <div>
                    <dt>垃圾箱游标</dt>
                    <dd>
                      {fmtDate(
                        m.cursors.find((c) => c.folder === "JUNKEMAIL")
                          ?.lastSuccessfulAt,
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {m.lastErrorMessage && (
                <div className="inline-error">{m.lastErrorMessage}</div>
              )}
              <div className="card-actions">
                {m.status === "AUTH_REQUIRED" && (
                  <button
                    onClick={() =>
                      m.provider === "GOOGLE"
                        ? connectOAuth("google")
                        : openMicrosoft(m)
                    }
                  >
                    <RefreshCw />
                    重新授权
                  </button>
                )}
                {m.status === "CONNECTED" ? (
                  <button onClick={() => act(m.id, "disable")}>
                    <CirclePause />
                    停用
                  </button>
                ) : (
                  m.status === "DISABLED" && (
                    <button onClick={() => act(m.id, "enable")}>
                      <Power />
                      启用
                    </button>
                  )
                )}
                <button
                  className="danger-link"
                  onClick={() => act(m.id, "remove")}
                >
                  <Trash2 />
                  移除
                </button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <Empty>
            <MailPlus size={38} />
            <h3>还没有连接邮箱</h3>
            <p>
              Microsoft OAuth 登录需要先在系统设置中配置 Client ID 和 Client
              Secret；Refresh Token 导入可直接使用对应的 Client ID。Gmail
              仍需先配置 Google OAuth。
            </p>
            <div className="provider-connect-actions">
              <button className="primary" onClick={() => openMicrosoft()}>
                添加 Microsoft
              </button>
              <button onClick={() => connectOAuth("google")}>连接 Gmail</button>
            </div>
          </Empty>
        </Card>
      )}
      {microsoftDialog && (
        <Modal title="添加 Microsoft 邮箱" wide onClose={closeMicrosoft}>
          <div className="auth-method-grid">
            <section className="auth-method-card recommended">
              <div className="auth-method-heading">
                <div className="auth-method-icon">
                  <LogIn />
                </div>
                <div>
                  <h3>OAuth 网页登录</h3>
                  <span className="recommended-badge">
                    <BadgeCheck /> 推荐
                  </span>
                </div>
              </div>
              <p>
                跳转到 Microsoft 官方登录页选择账号。授权成功后，系统会自动读取
                /me、创建或更新邮箱，并加密保存 MSAL Token Cache。
              </p>
              <ul>
                <li>不接触或保存 Microsoft 邮箱密码</li>
                <li>自动续期，可读取收件箱、垃圾箱并发送普通 Reply</li>
                <li>需要先在系统设置中配置 Microsoft Client ID 和 Secret</li>
              </ul>
              <button
                className="primary auth-method-submit"
                disabled={importing}
                onClick={() => {
                  closeMicrosoft();
                  void connectOAuth("microsoft");
                }}
              >
                <LogIn />
                使用 OAuth 登录
              </button>
            </section>

            <form
              className="auth-method-card"
              onSubmit={importMicrosoftRefreshToken}
            >
              <div className="auth-method-heading">
                <div className="auth-method-icon secondary">
                  <FileKey2 />
                </div>
                <div>
                  <h3>Client ID + Refresh Token</h3>
                  <span className="method-label">高级导入</span>
                </div>
              </div>
              <p>
                系统先在 Microsoft 官方 Token Endpoint 换取 Access
                Token，校验委托权限并读取 /me；全部成功后才保存邮箱。
              </p>
              <label>
                Client ID
                <input
                  required
                  value={refreshImport.clientId}
                  onChange={(event) =>
                    setRefreshImport({
                      ...refreshImport,
                      clientId: event.target.value,
                    })
                  }
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                Refresh Token
                <textarea
                  required
                  rows={6}
                  value={refreshImport.refreshToken}
                  onChange={(event) =>
                    setRefreshImport({
                      ...refreshImport,
                      refreshToken: event.target.value,
                    })
                  }
                  placeholder="粘贴与上方 Client ID 匹配的 Refresh Token"
                  autoComplete="off"
                  spellCheck={false}
                />
                <small>
                  必须包含 User.Read、Mail.ReadWrite、Mail.Send；若该应用要求
                  Client Secret，则不能使用这种仅两项导入方式。
                </small>
              </label>
              <button
                className="auth-method-submit"
                type="submit"
                disabled={importing}
              >
                <KeyRound />
                {importing ? "正在验证并导入…" : "验证并导入"}
              </button>
            </form>
          </div>
          <Notice>
            Refresh Token
            会使用实例主密钥加密保存，后台不会再次显示原文，也不会写入系统日志或审计日志。
          </Notice>
        </Modal>
      )}
    </>
  );
}
