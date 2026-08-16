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
import type { Mailbox, ProviderConfig } from "../types";
import { microsoftDialogDefaults } from "./mailbox-app-selection";
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
  const [microsoftConfig, setMicrosoftConfig] = useState<ProviderConfig>();
  const [googleConfig, setGoogleConfig] = useState<ProviderConfig>();
  const [microsoftDialog, setMicrosoftDialog] = useState(false);
  const [googleDialog, setGoogleDialog] = useState(false);
  const [microsoftOAuthAppId, setMicrosoftOAuthAppId] = useState("");
  const [googleOAuthAppId, setGoogleOAuthAppId] = useState("");
  const [refreshImport, setRefreshImport] = useState({
    appConfigId: "",
    clientId: "",
    refreshToken: "",
  });
  const [importing, setImporting] = useState(false);
  const load = useCallback(async () => {
    const [mailboxes, microsoft, google] = await Promise.all([
      api<Mailbox[]>("/api/v1/mailboxes"),
      api<ProviderConfig>("/api/v1/microsoft/config"),
      api<ProviderConfig>("/api/v1/google/config"),
    ]);
    setData(mailboxes);
    setMicrosoftConfig(microsoft);
    setGoogleConfig(google);
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
  async function connectOAuth(
    provider: "microsoft" | "google",
    appConfigId: string,
  ) {
    if (!appConfigId) {
      notify("请先选择要使用的应用配置", "danger");
      return;
    }
    try {
      const r = await api<{ authorizationUrl: string }>(
        `/api/v1/${provider}/oauth/start`,
        json("POST", { appConfigId, redirectAfter: "/mailboxes" }),
      );
      location.href = r.authorizationUrl;
    } catch (e) {
      notify(e instanceof Error ? e.message : "无法连接", "danger");
    }
  }
  function openMicrosoft(mailbox?: Mailbox) {
    const defaults = microsoftDialogDefaults(
      mailbox,
      microsoftConfig?.apps || [],
    );
    setMicrosoftOAuthAppId(defaults.oauthAppId);
    setRefreshImport(defaults.refreshImport);
    setMicrosoftDialog(true);
  }
  function closeMicrosoft() {
    if (importing) return;
    setMicrosoftDialog(false);
    setMicrosoftOAuthAppId("");
    setRefreshImport({ appConfigId: "", clientId: "", refreshToken: "" });
  }
  function openGoogle(mailbox?: Mailbox) {
    setGoogleOAuthAppId(
      mailbox?.googleAppConfigId || googleConfig?.apps[0]?.id || "",
    );
    setGoogleDialog(true);
  }
  function closeGoogle() {
    setGoogleOAuthAppId("");
    setGoogleDialog(false);
  }
  async function importMicrosoftRefreshToken(event: React.FormEvent) {
    event.preventDefault();
    setImporting(true);
    try {
      const result = await api<{ email: string }>(
        "/api/v1/microsoft/import-refresh-token",
        json("POST", {
          appConfigId: refreshImport.appConfigId || undefined,
          clientId: refreshImport.appConfigId
            ? undefined
            : refreshImport.clientId,
          refreshToken: refreshImport.refreshToken,
        }),
      );
      setMicrosoftDialog(false);
      setRefreshImport({ appConfigId: "", clientId: "", refreshToken: "" });
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
  if (!data || !microsoftConfig || !googleConfig) return <Loading />;
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
            <button onClick={() => openGoogle()}>
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
              Microsoft Graph →
              委托的权限；openid、profile、offline_access、User.Read、Mail.ReadWrite、Mail.Send，不能选应用程序权限
            </span>
          </div>
        </div>
        <div className="info-strip">
          <KeyRound />
          <div>
            <strong>Google OAuth 权限</strong>
            <span>
              先启用 Gmail API；Web OAuth 请求
              openid、email、profile、gmail.readonly、gmail.compose
            </span>
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
                <div>
                  <dt>应用配置</dt>
                  <dd>
                    {m.provider === "GOOGLE"
                      ? m.googleAppConfig?.name || "未绑定（需重新授权）"
                      : m.microsoftAppConfig?.name ||
                        (m.microsoftAuthMode === "CLIENT_ID_REFRESH_TOKEN"
                          ? "独立 Client ID"
                          : "未绑定（需重新授权）")}
                  </dd>
                </div>
                {m.provider === "MICROSOFT" &&
                  m.microsoftClientId &&
                  !m.microsoftAppConfig && (
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
                      m.provider === "GOOGLE" ? openGoogle(m) : openMicrosoft(m)
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
              <button onClick={() => openGoogle()}>连接 Gmail</button>
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
                <li>
                  Entra 应用账户类型必须是“任何组织目录中的账户和个人 Microsoft
                  账户”
                </li>
                <li>
                  身份验证平台必须选择 Web，并登记后台显示的 Microsoft OAuth
                  回调地址
                </li>
                <li>
                  Microsoft Graph
                  必须选择“委托的权限”：openid、profile、offline_access、User.Read、Mail.ReadWrite、Mail.Send
                </li>
                <li>
                  不要添加“应用程序权限”；企业策略要求时由租户管理员授予同意
                </li>
                <li>
                  需要先在系统设置中保存对应 Client ID 和 Client Secret Value
                </li>
              </ul>
              <label>
                使用 Microsoft Graph 应用
                <select
                  value={microsoftOAuthAppId}
                  onChange={(event) =>
                    setMicrosoftOAuthAppId(event.target.value)
                  }
                >
                  <option value="">请选择应用</option>
                  {microsoftConfig.apps.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name} · {app.clientId}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary auth-method-submit"
                disabled={importing || !microsoftOAuthAppId}
                onClick={() => {
                  closeMicrosoft();
                  void connectOAuth("microsoft", microsoftOAuthAppId);
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
                Token，再并行校验 /me、收件箱和垃圾箱；全部成功后才保存邮箱。
              </p>
              <ul>
                <li>Refresh Token 必须由同一个 Client ID 签发</li>
                <li>
                  授权必须包含
                  offline_access、User.Read、Mail.ReadWrite、Mail.Send
                </li>
                <li>必须是委托授权，不支持 Microsoft Graph 应用程序权限</li>
                <li>签发应用必须允许不提交 Client Secret 的公共客户端刷新</li>
              </ul>
              <label>
                Microsoft 应用
                <select
                  value={refreshImport.appConfigId}
                  onChange={(event) => {
                    const appConfigId = event.target.value;
                    const app = microsoftConfig.apps.find(
                      (item) => item.id === appConfigId,
                    );
                    setRefreshImport({
                      ...refreshImport,
                      appConfigId,
                      clientId: app?.clientId || "",
                    });
                  }}
                >
                  <option value="">手工填写独立 Client ID</option>
                  {microsoftConfig.apps.map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name} · {app.clientId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Client ID
                <input
                  required
                  disabled={Boolean(refreshImport.appConfigId)}
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
                  如果 Token 缺少权限、已撤销、不属于该 Client ID，或刷新时要求
                  Client
                  Secret，系统会拒绝导入且不会保存半成品邮箱。验证有明确时间上限，超时会返回阶段、错误码和请求
                  ID。
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
      {googleDialog && (
        <Modal title="连接 Gmail 邮箱" wide onClose={closeGoogle}>
          <div className="auth-method-grid">
            <section className="auth-method-card recommended">
              <div className="auth-method-heading">
                <div className="auth-method-icon">
                  <LogIn />
                </div>
                <div>
                  <h3>Google OAuth 网页登录</h3>
                  <span className="recommended-badge">
                    <BadgeCheck /> 唯一支持方式
                  </span>
                </div>
              </div>
              <p>
                跳转到 Google 官方授权页选择 Gmail 或 Google Workspace
                账号。系统不接触邮箱密码，并会加密保存用于无人值守续期的 Refresh
                Token。
              </p>
              <ul>
                <li>Google Cloud 项目必须先启用 Gmail API</li>
                <li>
                  OAuth 客户端类型必须是 Web application，并登记后台显示的
                  Google OAuth 回调地址
                </li>
                <li>
                  个人 Gmail 或组织外账号选择 External；仅 Workspace
                  组织内部可选择 Internal
                </li>
                <li>应用处于 Testing 时，要连接的邮箱必须加入 Test users</li>
              </ul>
            </section>
            <section className="auth-method-card">
              <div className="auth-method-heading">
                <div className="auth-method-icon secondary">
                  <KeyRound />
                </div>
                <div>
                  <h3>需要的 Google 权限</h3>
                  <span className="method-label">OAuth scopes</span>
                </div>
              </div>
              <ul>
                <li>openid、email、profile：识别授权账号和显示名称</li>
                <li>gmail.readonly：检测 History、INBOX/SPAM 标签和邮件头</li>
                <li>gmail.compose：创建并发送回复草稿、内嵌图片和固定附件</li>
              </ul>
              <p>
                gmail.readonly 与 gmail.compose 属于 Google 受限权限。External
                应用公开给大量用户前可能需要应用验证和安全评估；External +
                Testing 的 Refresh Token 通常会在 7 天后失效。
              </p>
              <code className="callback-path">
                https://你的域名/api/v1/google/oauth/callback
              </code>
            </section>
          </div>
          <Notice>
            请先在“系统设置 → Google / Gmail”添加至少一套应用，并保存 HTTPS
            公开地址。Gmail 当前不支持邮箱密码或直接粘贴 Refresh Token 导入。
          </Notice>
          <label>
            使用 Google / Gmail 应用
            <select
              value={googleOAuthAppId}
              onChange={(event) => setGoogleOAuthAppId(event.target.value)}
            >
              <option value="">请选择应用</option>
              {googleConfig.apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name} · {app.clientId}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button onClick={closeGoogle}>取消</button>
            <button
              className="primary"
              disabled={!googleOAuthAppId}
              onClick={() => {
                closeGoogle();
                void connectOAuth("google", googleOAuthAppId);
              }}
            >
              <LogIn />
              前往 Google 登录
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
