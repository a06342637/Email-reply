import { useEffect, useState } from "react";
import {
  ArchiveRestore,
  Download,
  HardDrive,
  Lock,
  MailPlus,
  Pencil,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
  Webhook,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { api, currentCsrf, json } from "../api";
import { useApp } from "../app-context";
import { UpdatePanel } from "../UpdatePanel";
import type { ProviderAppConfig, ProviderConfig, SmtpConfig } from "../types";
import {
  Card,
  Loading,
  Modal,
  Notice,
  PageHeader,
  fmtBytes,
  fmtDate,
} from "../ui";

type AppEditor = {
  provider: "microsoft" | "google";
  id?: string;
  name: string;
  clientId: string;
  clientSecret: string;
  secretExpiresAt?: string;
};

type SmtpEditor = {
  id?: string;
  name: string;
  host: string;
  port: number;
  security: "TLS" | "STARTTLS";
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  replyToEmail: string;
};

export function SettingsPage() {
  const { admin, applyUiSettings, refreshMe, notify } = useApp();
  const [data, setData] = useState<any>();
  const [ms, setMs] = useState<any>();
  const [google, setGoogle] = useState<any>();
  const [info, setInfo] = useState<any>();
  const [tab, setTab] = useState("general");
  const [totp, setTotp] = useState<any>();
  const [disableTotp, setDisableTotp] = useState(false);
  const [totpPassword, setTotpPassword] = useState("");
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [smtpConfigs, setSmtpConfigs] = useState<SmtpConfig[]>([]);
  const [appEditor, setAppEditor] = useState<AppEditor>();
  const [smtpEditor, setSmtpEditor] = useState<SmtpEditor>();
  const [smtpTest, setSmtpTest] = useState<SmtpConfig>();
  const [smtpTestRecipient, setSmtpTestRecipient] = useState("");
  async function load() {
    const [s, m, g, i, w, smtp] = await Promise.all([
      api("/api/v1/settings"),
      api("/api/v1/microsoft/config"),
      api("/api/v1/google/config"),
      api("/api/v1/system/info"),
      api<any[]>("/api/v1/webhooks"),
      api<SmtpConfig[]>("/api/v1/smtp/configs"),
    ]);
    setData(s);
    setMs(m);
    setGoogle(g);
    setInfo(i);
    setWebhooks(w);
    setSmtpConfigs(smtp);
  }
  useEffect(() => {
    void load();
  }, []);
  if (!data || !ms || !google || !info) return <Loading />;
  async function saveSettings() {
    const saved = await api<any>(
      "/api/v1/settings",
      json("PATCH", {
        siteName: data.siteName,
        timezone: data.timezone,
        defaultPollIntervalSeconds: data.defaultPollIntervalSeconds,
        defaultBacklogPerMinute: data.defaultBacklogPerMinute,
        excludedAddresses: data.excludedAddresses,
        excludedDomains: data.excludedDomains,
        attachmentLimitMb: data.attachmentLimitMb,
        processingLogDays: data.processingLogDays,
        systemLogDays: data.systemLogDays,
        alertLogDays: data.alertLogDays,
        auditLogDays: data.auditLogDays,
        dedupeDays: data.dedupeDays,
        sessionIdleMinutes: data.sessionIdleMinutes,
        sessionAbsoluteMinutes: data.sessionAbsoluteMinutes,
      }),
    );
    setData(saved);
    applyUiSettings(saved);
    notify("系统设置已保存");
  }
  async function saveProviderPublicUrl(provider: "microsoft" | "google") {
    const config = provider === "microsoft" ? ms : google;
    await api(
      `/api/v1/${provider}/public-url`,
      json("PATCH", { publicUrl: config.publicUrl || "" }),
    );
    notify("HTTPS 公开地址已保存");
    await load();
  }
  function editApp(provider: "microsoft" | "google", app?: ProviderAppConfig) {
    setAppEditor({
      provider,
      id: app?.id,
      name:
        app?.name ||
        (provider === "microsoft"
          ? `Microsoft 应用 ${(ms.apps?.length ?? 0) + 1}`
          : `Google / Gmail 应用 ${(google.apps?.length ?? 0) + 1}`),
      clientId: app?.clientId || "",
      clientSecret: "",
      secretExpiresAt: dateInput(app?.secretExpiresAt || undefined),
    });
  }
  async function saveApp() {
    if (!appEditor) return;
    const payload: Record<string, unknown> = {
      name: appEditor.name,
      clientId: appEditor.clientId,
      clientSecret: appEditor.clientSecret || undefined,
    };
    if (appEditor.provider === "microsoft")
      payload.secretExpiresAt = appEditor.secretExpiresAt || null;
    await api(
      appEditor.id
        ? `/api/v1/${appEditor.provider}/apps/${appEditor.id}`
        : `/api/v1/${appEditor.provider}/apps`,
      json(appEditor.id ? "PATCH" : "POST", payload),
    );
    notify(appEditor.id ? "应用配置已更新" : "应用配置已添加");
    setAppEditor(undefined);
    await load();
  }
  async function deleteApp(
    provider: "microsoft" | "google",
    app: ProviderAppConfig,
  ) {
    if (!confirm(`确定删除应用“${app.name}”吗？仍被邮箱使用时系统会拒绝删除。`))
      return;
    try {
      await api(`/api/v1/${provider}/apps/${app.id}`, json("DELETE"));
      notify("应用配置已删除");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除应用失败", "danger");
    }
  }
  function editSmtp(config?: SmtpConfig) {
    setSmtpEditor({
      id: config?.id,
      name: config?.name || `SMTP 配置 ${smtpConfigs.length + 1}`,
      host: config?.host || "",
      port: config?.port || 587,
      security: config?.security || "STARTTLS",
      username: config?.username || "",
      password: "",
      fromEmail: config?.fromEmail || "",
      fromName: config?.fromName || "",
      replyToEmail: config?.replyToEmail || "",
    });
  }
  async function saveSmtp() {
    if (!smtpEditor) return;
    try {
      await api(
        smtpEditor.id
          ? `/api/v1/smtp/configs/${smtpEditor.id}`
          : "/api/v1/smtp/configs",
        json(smtpEditor.id ? "PATCH" : "POST", {
          name: smtpEditor.name,
          host: smtpEditor.host,
          port: Number(smtpEditor.port),
          security: smtpEditor.security,
          username: smtpEditor.username,
          password: smtpEditor.password || undefined,
          fromEmail: smtpEditor.fromEmail,
          fromName: smtpEditor.fromName.trim() || null,
          replyToEmail: smtpEditor.replyToEmail.trim() || null,
        }),
      );
      notify(smtpEditor.id ? "SMTP 配置已更新" : "SMTP 配置已添加");
      setSmtpEditor(undefined);
      await load();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "SMTP 配置保存失败",
        "danger",
      );
    }
  }
  async function deleteSmtp(config: SmtpConfig) {
    if (
      !confirm(
        `确定删除 SMTP 配置“${config.name}”吗？仍被任务使用时系统会拒绝删除。`,
      )
    )
      return;
    try {
      await api(`/api/v1/smtp/configs/${config.id}`, json("DELETE"));
      notify("SMTP 配置已删除");
      await load();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "SMTP 配置删除失败",
        "danger",
      );
    }
  }
  async function runSmtpTest() {
    if (!smtpTest) return;
    try {
      await api(
        `/api/v1/smtp/configs/${smtpTest.id}/test`,
        json("POST", {
          recipient: smtpTestRecipient || undefined,
        }),
      );
      notify(
        smtpTestRecipient
          ? "SMTP 服务器已接受测试邮件"
          : "SMTP 连接与身份验证成功",
      );
      setSmtpTest(undefined);
      setSmtpTestRecipient("");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "SMTP 测试失败",
        "danger",
      );
    }
  }
  async function turnOffTotp() {
    await api(
      "/api/v1/auth/totp/disable",
      json("POST", { password: totpPassword }),
    );
    setDisableTotp(false);
    setTotpPassword("");
    await refreshMe();
    notify("双重验证已关闭");
  }
  return (
    <>
      <PageHeader
        title="系统设置"
        description="站点、邮件提供商、登录安全、保留周期、备份和健康状态。"
      />
      <div className="settings-tabs">
        {[
          ["general", "常规"],
          ["microsoft", "Microsoft"],
          ["google", "Google / Gmail"],
          ["smtp", "SMTP 发件"],
          ["security", "登录安全"],
          ["backup", "备份恢复"],
          ["update", "在线升级"],
          ["system", "系统状态"],
        ].map((x) => (
          <button
            key={x[0]}
            className={tab === x[0] ? "active" : ""}
            onClick={() => setTab(x[0]!)}
          >
            {x[1]}
          </button>
        ))}
      </div>
      {tab === "general" && (
        <Card>
          <div className="settings-section">
            <h2>常规与邮件处理</h2>
            <div className="form-grid">
              <label>
                站点名称
                <input
                  maxLength={120}
                  value={data.siteName}
                  onChange={(e) =>
                    setData({ ...data, siteName: e.target.value })
                  }
                />
              </label>
              <label>
                时区
                <input
                  maxLength={120}
                  value={data.timezone}
                  onChange={(e) =>
                    setData({ ...data, timezone: e.target.value })
                  }
                />
              </label>
              <label>
                默认检测周期（秒）
                <input
                  type="number"
                  min="3"
                  max="3600"
                  value={data.defaultPollIntervalSeconds}
                  onChange={(e) =>
                    setData({
                      ...data,
                      defaultPollIntervalSeconds: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                默认积压限速（每分钟）
                <input
                  type="number"
                  min="1"
                  max="300"
                  value={data.defaultBacklogPerMinute}
                  onChange={(e) =>
                    setData({
                      ...data,
                      defaultBacklogPerMinute: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                附件总量限制（MB）
                <input
                  type="number"
                  min="1"
                  max="25"
                  value={data.attachmentLimitMb}
                  onChange={(e) =>
                    setData({
                      ...data,
                      attachmentLimitMb: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
            <h3>自定义排除名单</h3>
            <div className="form-grid">
              <label>
                邮箱地址 <small>每行一个</small>
                <textarea
                  rows={5}
                  value={(data.excludedAddresses || []).join("\n")}
                  onChange={(e) =>
                    setData({
                      ...data,
                      excludedAddresses: lines(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                域名 <small>每行一个</small>
                <textarea
                  rows={5}
                  value={(data.excludedDomains || []).join("\n")}
                  onChange={(e) =>
                    setData({ ...data, excludedDomains: lines(e.target.value) })
                  }
                />
              </label>
            </div>
            <h3>日志和告警保存周期（天）</h3>
            <p className="muted-copy">
              Worker 按系统时区的自然日每天清理。设置 3 天时，从第 4
              天开始删除第 1
              天的全部记录；处理日志、系统日志、告警记录和审计日志超过各自周期后都会删除，告警不再因状态而额外保留。
            </p>
            <div className="form-grid four">
              <NumberField
                label="处理日志"
                value={data.processingLogDays}
                onChange={(v) => setData({ ...data, processingLogDays: v })}
              />
              <NumberField
                label="系统日志"
                value={data.systemLogDays}
                onChange={(v) => setData({ ...data, systemLogDays: v })}
              />
              <NumberField
                label="告警记录"
                value={data.alertLogDays}
                onChange={(v) => setData({ ...data, alertLogDays: v })}
              />
              <NumberField
                label="审计日志"
                value={data.auditLogDays}
                onChange={(v) => setData({ ...data, auditLogDays: v })}
              />
            </div>
            <h3>可靠性数据保存周期（天）</h3>
            <p className="muted-copy">
              去重指纹用于阻止同一封邮件被重复回复，建议保留默认 365
              天；缩短后，极旧邮件在异常重新扫描时的重复保护时间也会缩短。
            </p>
            <div className="form-grid four">
              <NumberField
                label="去重指纹"
                value={data.dedupeDays}
                onChange={(v) => setData({ ...data, dedupeDays: v })}
              />
            </div>
            <button className="primary" onClick={saveSettings}>
              <Save />
              保存设置
            </button>
            <hr />
            <WebhookPanel items={webhooks} onChanged={load} notify={notify} />
          </div>
        </Card>
      )}
      {tab === "microsoft" && (
        <Card>
          <div className="settings-section">
            <h2>Microsoft Graph 应用</h2>
            <Notice>
              应用注册必须选择“任何组织目录中的账户和个人 Microsoft
              账户”。这里的 Client ID/Secret 只供“OAuth
              网页登录”方式使用；使用独立 Client ID + Refresh Token
              导入的邮箱不受这里的 Client ID 变更影响。Client Secret
              保存后不再回显。
            </Notice>
            <h3>Microsoft Entra 配置清单</h3>
            <div className="provider-setup-grid">
              <section>
                <strong>1. 注册应用与账户类型</strong>
                <p>
                  Entra 管理中心 → 应用注册 →
                  新注册。支持的账户类型选择“任何组织目录中的账户和个人
                  Microsoft 账户”，这样才能同时连接 Outlook/Hotmail 和全球版
                  Microsoft 365 用户邮箱。
                </p>
              </section>
              <section>
                <strong>2. 添加 Web 回调</strong>
                <p>
                  身份验证 → 添加平台 → Web，把下方 OAuth
                  回调地址原样加入“重定向 URI”。必须使用
                  HTTPS，不能增加结尾斜杠、路径或参数。
                </p>
              </section>
              <section>
                <strong>3. 添加委托权限</strong>
                <p>
                  API 权限 → 添加权限 → Microsoft Graph →
                  <b> 委托的权限（Delegated permissions）</b>，添加
                  openid、profile、offline_access、User.Read、Mail.ReadWrite、Mail.Send。
                </p>
              </section>
              <section>
                <strong>4. 同意与 Client Secret</strong>
                <p>
                  企业租户若禁止用户自行同意，需要租户管理员批准或“代表组织授予管理员同意”。随后在“证书和密码”创建
                  Client Secret，并复制 <b>Value</b>，不要复制 Secret ID。
                </p>
              </section>
            </div>
            <Notice kind="danger">
              不要选择“应用程序权限（Application
              permissions）”。本系统只使用登录用户的委托权限；给错权限会导致登录后仍无法读信或发信。
            </Notice>
            <div className="provider-app-heading">
              <div>
                <h3>已保存的 Microsoft 应用</h3>
                <p>
                  每个邮箱在连接时选择一套应用，修改只影响绑定该应用的邮箱。
                </p>
              </div>
              <button className="primary" onClick={() => editApp("microsoft")}>
                <Plus /> 添加应用
              </button>
            </div>
            <ProviderAppList
              provider="microsoft"
              config={ms}
              onEdit={(app) => editApp("microsoft", app)}
              onDelete={(app) => deleteApp("microsoft", app)}
            />
            <div className="form-grid provider-public-url">
              <label>
                HTTPS 公开地址
                <input
                  value={ms.publicUrl || ""}
                  onChange={(e) => setMs({ ...ms, publicUrl: e.target.value })}
                  placeholder="https://mail.example.com"
                />
              </label>
              <button
                className="primary"
                onClick={() => saveProviderPublicUrl("microsoft")}
              >
                <Save /> 保存公开地址
              </button>
            </div>
            <div className="callback">
              <span>OAuth 回调地址</span>
              <code>{ms.callbackUrl}</code>
            </div>
            <h3>系统请求的完整 Microsoft 权限</h3>
            <div className="scope-list">
              {ms.scopes.map((s: string) => (
                <span key={s}>{s}</span>
              ))}
            </div>
            <p className="permission-help">
              openid、profile 用于识别登录账户；offline_access
              用于无人值守续期；User.Read 读取当前用户；Mail.ReadWrite
              读取收件箱/垃圾箱并管理回复草稿；Mail.Send 发送普通 Reply。
            </p>
            <Notice>
              “Client ID + Refresh
              Token”高级导入可直接选择上方已保存应用，也可手工填写独立 Client
              ID。该 Token 必须属于同一个 Client ID，来自委托授权，并至少包含
              offline_access、User.Read、Mail.ReadWrite、Mail.Send；签发应用还必须允许不提交
              Client Secret 的公共客户端刷新。
            </Notice>
          </div>
        </Card>
      )}
      {tab === "google" && (
        <Card>
          <div className="settings-section">
            <h2>Google Cloud / Gmail API 应用</h2>
            <Notice>
              请在 Google Cloud 启用 Gmail API，并创建“Web 应用”OAuth
              客户端。若应用仍处于“测试中”，外部用户的刷新令牌通常会在 7
              天后失效；Client Secret 保存后不再回显。
            </Notice>
            <h3>Google Cloud 配置清单</h3>
            <div className="provider-setup-grid">
              <section>
                <strong>1. 启用 Gmail API</strong>
                <p>
                  Google Cloud Console → API 和服务 → 库 → Gmail API →
                  启用。只创建 OAuth 客户端但未启用 Gmail
                  API，会在连接后读取或发信时返回 403。
                </p>
              </section>
              <section>
                <strong>2. 配置 OAuth 同意屏幕</strong>
                <p>
                  Google Auth Platform → Branding / Audience。个人 Gmail
                  或组织外账户选择 External；仅 Workspace 组织内部可选择
                  Internal。Testing 状态时必须把要连接的邮箱加入 Test users。
                </p>
              </section>
              <section>
                <strong>3. 添加数据访问范围</strong>
                <p>
                  Data Access 中确认
                  openid、email、profile、gmail.readonly、gmail.compose。readonly
                  用于检测邮件和标签，compose 用于创建并发送带
                  HTML、内嵌图片或附件的回复草稿。
                </p>
              </section>
              <section>
                <strong>4. 创建 Web OAuth Client</strong>
                <p>
                  Clients → Create Client → Web application，把下方地址加入
                  Authorized redirect URIs。这里不需要把后台地址填入 JavaScript
                  origins。
                </p>
              </section>
            </div>
            <div className="provider-app-heading">
              <div>
                <h3>已保存的 Google / Gmail 应用</h3>
                <p>
                  可以为不同 Gmail 或 Workspace 邮箱分别使用不同的 Google Cloud
                  项目。
                </p>
              </div>
              <button className="primary" onClick={() => editApp("google")}>
                <Plus /> 添加应用
              </button>
            </div>
            <ProviderAppList
              provider="google"
              config={google}
              onEdit={(app) => editApp("google", app)}
              onDelete={(app) => deleteApp("google", app)}
            />
            <div className="form-grid provider-public-url">
              <label>
                HTTPS 公开地址
                <input
                  value={google.publicUrl || ""}
                  onChange={(e) =>
                    setGoogle({ ...google, publicUrl: e.target.value })
                  }
                  placeholder="https://mail.example.com"
                />
              </label>
              <button
                className="primary"
                onClick={() => saveProviderPublicUrl("google")}
              >
                <Save /> 保存公开地址
              </button>
            </div>
            <div className="callback">
              <span>OAuth 回调地址</span>
              <code>{google.callbackUrl}</code>
            </div>
            <h3>系统请求的完整 Google 权限</h3>
            <div className="scope-list">
              {google.scopes.map((scope: string) => (
                <span key={scope}>{scope}</span>
              ))}
            </div>
            <Notice>
              Gmail 权限包含 Google 受限权限。公开提供给大量外部用户前，Google
              可能要求完成 OAuth
              应用验证和安全评估；自用或测试阶段请把邮箱加入“测试用户”。Gmail
              当前只支持 OAuth 网页登录，不支持直接粘贴邮箱密码。
            </Notice>
          </div>
        </Card>
      )}
      {tab === "smtp" && (
        <Card>
          <div className="settings-section">
            <div className="provider-app-heading">
              <div>
                <h2>SMTP 发件配置</h2>
                <p>
                  收件检测仍由 Microsoft Graph 或 Gmail API
                  完成；每个自动回复任务可以单独选择使用邮箱服务商 API 或这里的
                  SMTP 配置发件。
                </p>
              </div>
              <button className="primary" onClick={() => editSmtp()}>
                <Plus /> 添加 SMTP
              </button>
            </div>
            <Notice>
              推荐使用 465 + TLS 或 587 + STARTTLS。系统强制 TLS 1.2
              以上并验证服务器证书，不支持明文 SMTP。Gmail、Outlook
              等服务通常需要应用专用密码；发件地址必须是 SMTP
              服务允许使用的地址。
            </Notice>
            <Notice kind="danger">
              SMTP 服务器“接受”邮件仍不等于目标邮箱最终投递。发件域名应正确配置
              SPF、DKIM 和
              DMARC，并避免大量营销链接、短链或正文与纯文本版本不一致。
            </Notice>
            {smtpConfigs.length ? (
              <div className="provider-app-list smtp-config-list">
                {smtpConfigs.map((config) => (
                  <section key={config.id}>
                    <div className="provider-app-card-head">
                      <div>
                        <strong>{config.name}</strong>
                        <span>{config.taskCount} 个任务正在使用</span>
                      </div>
                      <div className="row-actions">
                        <button
                          onClick={() => {
                            setSmtpTest(config);
                            setSmtpTestRecipient("");
                          }}
                        >
                          <Send /> 测试
                        </button>
                        <button onClick={() => editSmtp(config)}>
                          <Pencil /> 编辑
                        </button>
                        <button
                          className="danger-link"
                          onClick={() => deleteSmtp(config)}
                        >
                          <Trash2 /> 删除
                        </button>
                      </div>
                    </div>
                    <code>
                      {config.host}:{config.port} · {config.security}
                    </code>
                    <div className="provider-app-meta">
                      <span>登录：{config.username}</span>
                      <span>
                        发件：{config.fromName ? `${config.fromName} · ` : ""}
                        {config.fromEmail}
                      </span>
                      <span>
                        Reply-To：{config.replyToEmail || "使用被检测邮箱地址"}
                      </span>
                      <span>密码：已加密保存</span>
                    </div>
                  </section>
                ))}
              </div>
            ) : (
              <Notice>
                尚未添加 SMTP 配置；现有任务仍可继续使用 Graph / Gmail API
                发件。
              </Notice>
            )}
          </div>
        </Card>
      )}
      {tab === "security" && (
        <Card>
          <div className="settings-section">
            <h2>管理员安全</h2>
            {admin.mustChangePassword && (
              <Notice kind="danger">
                当前使用安装时生成的临时密码，必须尽快修改。
              </Notice>
            )}
            <PasswordPanel
              onDone={() => {
                notify("密码已修改，请重新登录");
                location.href = "/";
              }}
            />
            <hr />
            <div className="form-grid">
              <NumberField
                label="会话空闲分钟"
                value={data.sessionIdleMinutes}
                min={5}
                max={1440}
                onChange={(v) => setData({ ...data, sessionIdleMinutes: v })}
              />
              <NumberField
                label="会话最长分钟"
                value={data.sessionAbsoluteMinutes}
                min={10}
                max={10080}
                onChange={(v) =>
                  setData({ ...data, sessionAbsoluteMinutes: v })
                }
              />
            </div>
            <button onClick={saveSettings}>
              <Save />
              保存会话策略
            </button>
            <hr />
            <div className="security-row">
              <div>
                <h3>双重验证（TOTP）</h3>
                <p>
                  {admin.totpEnabled
                    ? "已启用；登录时需要验证码或一次性恢复码。"
                    : "尚未启用，推荐配合密码管理器或身份验证器使用。"}
                </p>
              </div>
              {admin.totpEnabled ? (
                <button
                  className="danger-link"
                  onClick={() => setDisableTotp(true)}
                >
                  <Lock />
                  关闭 TOTP
                </button>
              ) : (
                <button
                  className="primary soft"
                  onClick={async () =>
                    setTotp(await api("/api/v1/auth/totp/setup", json("POST")))
                  }
                >
                  <ShieldCheck />
                  设置 TOTP
                </button>
              )}
            </div>
          </div>
        </Card>
      )}
      {tab === "backup" && <BackupPanel notify={notify} />}{" "}
      {tab === "update" && <UpdatePanel notify={notify} />}
      {tab === "system" && (
        <Card>
          <div className="settings-section">
            <h2>运行环境</h2>
            <div className="system-grid">
              <System label="应用版本" value={info.version} />
              <System label="Node.js" value={info.node} />
              <System label="数据库" value={info.database ? "正常" : "异常"} />
              <System label="Redis" value={info.redis ? "正常" : "异常"} />
              <System label="健康 Worker" value={String(info.healthyWorkers)} />
              <System label="待处理队列" value={String(info.taskBacklog)} />
              <System
                label="数据库占用"
                value={
                  typeof info.databaseSize === "number"
                    ? fmtBytes(info.databaseSize)
                    : "未知"
                }
              />
              <System
                label="磁盘可用"
                value={info.disk ? fmtBytes(info.disk.free) : "未知"}
              />
            </div>
            <h3>Worker 心跳</h3>
            <div className="worker-list">
              {info.workers.map((w: any) => (
                <div key={w.id}>
                  <HardDrive />
                  <div>
                    <strong>{w.id}</strong>
                    <small>
                      {w.hostname} · PID {w.pid}
                    </small>
                  </div>
                  <span>{fmtDate(w.updatedAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}
      {appEditor && (
        <Modal
          title={`${appEditor.id ? "编辑" : "添加"} ${
            appEditor.provider === "microsoft"
              ? "Microsoft Graph"
              : "Google / Gmail"
          } 应用`}
          onClose={() => setAppEditor(undefined)}
        >
          <Notice>
            应用名称只用于后台区分不同凭据。Client Secret
            保存后不再显示；编辑时留空表示继续使用原 Secret。
          </Notice>
          <label>
            应用名称
            <input
              value={appEditor.name}
              onChange={(event) =>
                setAppEditor({ ...appEditor, name: event.target.value })
              }
              placeholder="例如：客服 Outlook 应用"
            />
          </label>
          <label>
            Client ID
            <input
              value={appEditor.clientId}
              onChange={(event) =>
                setAppEditor({ ...appEditor, clientId: event.target.value })
              }
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            Client Secret
            <input
              type="password"
              value={appEditor.clientSecret}
              onChange={(event) =>
                setAppEditor({
                  ...appEditor,
                  clientSecret: event.target.value,
                })
              }
              placeholder={
                appEditor.id ? "已保存；留空不替换" : "请输入 Secret Value"
              }
              autoComplete="new-password"
            />
          </label>
          {appEditor.provider === "microsoft" && (
            <label>
              Secret 到期日
              <input
                type="date"
                value={appEditor.secretExpiresAt || ""}
                onChange={(event) =>
                  setAppEditor({
                    ...appEditor,
                    secretExpiresAt: event.target.value,
                  })
                }
              />
            </label>
          )}
          <div className="modal-actions">
            <button onClick={() => setAppEditor(undefined)}>取消</button>
            <button
              className="primary"
              disabled={
                !appEditor.name.trim() ||
                !appEditor.clientId.trim() ||
                (!appEditor.id && !appEditor.clientSecret)
              }
              onClick={saveApp}
            >
              <Save /> 保存应用
            </button>
          </div>
        </Modal>
      )}
      {smtpEditor && (
        <Modal
          title={smtpEditor.id ? "编辑 SMTP 配置" : "添加 SMTP 配置"}
          onClose={() => setSmtpEditor(undefined)}
        >
          <div className="form-grid">
            <label>
              配置名称
              <input
                value={smtpEditor.name}
                onChange={(event) =>
                  setSmtpEditor({ ...smtpEditor, name: event.target.value })
                }
              />
            </label>
            <label>
              SMTP 主机
              <input
                value={smtpEditor.host}
                placeholder="smtp.example.com"
                onChange={(event) =>
                  setSmtpEditor({ ...smtpEditor, host: event.target.value })
                }
              />
            </label>
            <label>
              端口
              <input
                type="number"
                min={1}
                max={65535}
                value={smtpEditor.port}
                onChange={(event) =>
                  setSmtpEditor({
                    ...smtpEditor,
                    port: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              加密模式
              <select
                value={smtpEditor.security}
                onChange={(event) =>
                  setSmtpEditor({
                    ...smtpEditor,
                    security: event.target.value as "TLS" | "STARTTLS",
                    port: event.target.value === "TLS" ? 465 : 587,
                  })
                }
              >
                <option value="STARTTLS">STARTTLS（通常 587）</option>
                <option value="TLS">TLS（通常 465）</option>
              </select>
            </label>
            <label>
              SMTP 用户名
              <input
                value={smtpEditor.username}
                autoComplete="off"
                onChange={(event) =>
                  setSmtpEditor({ ...smtpEditor, username: event.target.value })
                }
              />
            </label>
            <label>
              {smtpEditor.id
                ? "新密码（留空保持不变）"
                : "SMTP 密码 / 应用专用密码"}
              <input
                type="password"
                value={smtpEditor.password}
                autoComplete="new-password"
                onChange={(event) =>
                  setSmtpEditor({ ...smtpEditor, password: event.target.value })
                }
              />
            </label>
            <label>
              发件地址
              <input
                type="email"
                value={smtpEditor.fromEmail}
                onChange={(event) =>
                  setSmtpEditor({
                    ...smtpEditor,
                    fromEmail: event.target.value,
                  })
                }
              />
            </label>
            <label>
              发件人名称
              <input
                value={smtpEditor.fromName}
                onChange={(event) =>
                  setSmtpEditor({ ...smtpEditor, fromName: event.target.value })
                }
              />
            </label>
            <label>
              固定 Reply-To（可选）
              <input
                type="email"
                value={smtpEditor.replyToEmail}
                placeholder="留空时使用被检测邮箱"
                onChange={(event) =>
                  setSmtpEditor({
                    ...smtpEditor,
                    replyToEmail: event.target.value,
                  })
                }
              />
            </label>
          </div>
          <div className="modal-actions">
            <button onClick={() => setSmtpEditor(undefined)}>取消</button>
            <button
              className="primary"
              disabled={
                !smtpEditor.name.trim() ||
                !smtpEditor.host.trim() ||
                !smtpEditor.username.trim() ||
                !smtpEditor.fromEmail.trim() ||
                (!smtpEditor.id && !smtpEditor.password)
              }
              onClick={saveSmtp}
            >
              <Save /> 保存 SMTP
            </button>
          </div>
        </Modal>
      )}
      {smtpTest && (
        <Modal
          title={`测试 SMTP · ${smtpTest.name}`}
          onClose={() => setSmtpTest(undefined)}
        >
          <Notice>
            收件地址留空只测试 TLS
            连接和身份验证；填写地址会额外发送一封简单测试邮件。
          </Notice>
          <label>
            测试收件地址（可选）
            <input
              type="email"
              value={smtpTestRecipient}
              onChange={(event) => setSmtpTestRecipient(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button onClick={() => setSmtpTest(undefined)}>取消</button>
            <button className="primary" onClick={runSmtpTest}>
              <MailPlus /> 开始测试
            </button>
          </div>
        </Modal>
      )}
      {totp && (
        <TotpModal
          data={totp}
          onEnabled={refreshMe}
          onClose={() => setTotp(null)}
        />
      )}
      {disableTotp && (
        <Modal title="关闭双重验证" onClose={() => setDisableTotp(false)}>
          <Notice kind="danger">
            关闭后登录只依赖管理员密码。请输入当前密码确认此操作。
          </Notice>
          <label>
            当前管理员密码
            <input
              type="password"
              value={totpPassword}
              onChange={(event) => setTotpPassword(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button onClick={() => setDisableTotp(false)}>取消</button>
            <button
              className="danger"
              disabled={!totpPassword}
              onClick={turnOffTotp}
            >
              确认关闭
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ProviderAppList({
  provider,
  config,
  onEdit,
  onDelete,
}: {
  provider: "microsoft" | "google";
  config: ProviderConfig;
  onEdit: (app: ProviderAppConfig) => void;
  onDelete: (app: ProviderAppConfig) => void;
}) {
  if (!config.apps.length)
    return (
      <Notice kind="danger">
        尚未添加应用。添加邮箱前必须先保存至少一套
        {provider === "microsoft" ? " Microsoft Graph" : " Google / Gmail"}
        应用凭据。
      </Notice>
    );
  return (
    <div className="provider-app-list">
      {config.apps.map((app) => (
        <section key={app.id}>
          <div className="provider-app-card-head">
            <div>
              <strong>{app.name}</strong>
              <span>{app.mailboxCount} 个邮箱正在使用</span>
            </div>
            <div className="row-actions">
              <button onClick={() => onEdit(app)}>
                <Pencil /> 编辑
              </button>
              <button className="danger-link" onClick={() => onDelete(app)}>
                <Trash2 /> 删除
              </button>
            </div>
          </div>
          <code>{app.clientId}</code>
          <div className="provider-app-meta">
            <span>Secret：已加密保存</span>
            {provider === "microsoft" && (
              <span>
                到期：
                {app.secretExpiresAt ? fmtDate(app.secretExpiresAt) : "未填写"}
              </span>
            )}
            <span>更新：{fmtDate(app.updatedAt)}</span>
          </div>
        </section>
      ))}
    </div>
  );
}

function PasswordPanel({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  async function save() {
    await api(
      "/api/v1/auth/password",
      json("POST", { currentPassword: current, newPassword: next }),
    );
    onDone();
  }
  return (
    <div>
      <h3>修改管理员密码</h3>
      <div className="form-grid">
        <label>
          当前密码
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label>
          新密码（至少 12 位）
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
      </div>
      <button disabled={next.length < 12 || !current} onClick={save}>
        <Lock />
        修改密码并注销会话
      </button>
    </div>
  );
}

function WebhookPanel({
  items,
  onChanged,
  notify,
}: {
  items: any[];
  onChanged: () => Promise<void>;
  notify: (value: string, kind?: any) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  async function create() {
    const result = await api<{ id: string; secret: string }>(
      "/api/v1/webhooks",
      json("POST", { name, url, eventTypes: ["*"] }),
    );
    alert(`Webhook 已创建。请立即保存签名密钥：\n\n${result.secret}`);
    setName("");
    setUrl("");
    notify("Webhook 已创建");
    await onChanged();
  }
  async function action(
    id: string,
    type: "test" | "delete" | "toggle",
    enabled?: boolean,
  ) {
    if (type === "delete" && !confirm("确定删除此 Webhook？")) return;
    if (type === "toggle")
      await api(`/api/v1/webhooks/${id}`, json("PATCH", { enabled: !enabled }));
    else
      await api(
        `/api/v1/webhooks/${id}${type === "test" ? "/test" : ""}`,
        json(type === "test" ? "POST" : "DELETE"),
      );
    notify(
      type === "test"
        ? "测试告警已排队"
        : type === "delete"
          ? "Webhook 已删除"
          : enabled
            ? "Webhook 已停用"
            : "Webhook 已启用",
    );
    await onChanged();
  }
  return (
    <div>
      <h3>
        <Webhook /> 通用 Webhook
      </h3>
      <p className="muted-copy">
        告警正文不包含发件人、主题或邮件正文；使用时间戳和 HMAC-SHA256 签名。
      </p>
      <div className="form-grid">
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          HTTPS 地址
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://monitor.example.com/hook"
          />
        </label>
      </div>
      <button disabled={!name || !url.startsWith("https://")} onClick={create}>
        添加端点
      </button>
      <div className="webhook-list">
        {items.map((item) => (
          <div key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <small>{item.url}</small>
            </div>
            <span>{item.enabled ? "启用" : "停用"}</span>
            <button onClick={() => action(item.id, "toggle", item.enabled)}>
              {item.enabled ? "停用" : "启用"}
            </button>
            <button onClick={() => action(item.id, "test")}>测试</button>
            <button
              className="danger-link"
              onClick={() => action(item.id, "delete")}
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
function BackupPanel({ notify }: { notify: (s: string, k?: any) => void }) {
  const [pass, setPass] = useState("");
  const [confirmPass, setConfirm] = useState("");
  const [file, setFile] = useState<File>();
  const [summary, setSummary] = useState<any>();
  async function download() {
    try {
      const response = await fetch("/api/v1/backups/export", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": currentCsrf(),
        },
        body: JSON.stringify({ passphrase: pass, confirmation: confirmPass }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message || "备份失败");
      }
      const blob = await response.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mailpilot-backup-${new Date().toISOString().slice(0, 10)}.mpbak`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify("加密备份已下载");
    } catch (error) {
      notify(error instanceof Error ? error.message : "备份失败", "danger");
    }
  }
  async function inspect() {
    if (!file) return;
    try {
      const f = new FormData();
      f.append("file", file);
      f.append("passphrase", pass);
      setSummary(
        await api("/api/v1/backups/inspect", { method: "POST", body: f }),
      );
      notify("备份检查通过");
    } catch (error) {
      setSummary(undefined);
      notify(error instanceof Error ? error.message : "备份检查失败", "danger");
    }
  }
  async function restore() {
    if (
      !file ||
      !confirm(
        "恢复会合并或覆盖同 ID 业务数据，并暂停所有自动回复任务。若目标服务器存在同邮箱但不同内部 ID，系统会拒绝恢复以避免串号；当前管理员账号保持不变。确定恢复？",
      )
    )
      return;
    try {
      const f = new FormData();
      f.append("file", file);
      f.append("passphrase", pass);
      f.append("confirmation", "RESTORE");
      await api("/api/v1/backups/restore", { method: "POST", body: f });
      notify("备份已恢复，所有任务保持暂停");
    } catch (error) {
      notify(error instanceof Error ? error.message : "恢复失败", "danger");
    }
  }
  return (
    <Card>
      <div className="settings-section">
        <h2>加密备份与恢复</h2>
        <Notice kind="danger">
          忘记备份口令将无法恢复，系统不设后门。备份不包含管理员密码、TOTP
          和会话。
        </Notice>
        <div className="backup-grid">
          <div>
            <h3>
              <Download />
              导出手工备份
            </h3>
            <label>
              备份口令
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </label>
            <label>
              确认口令
              <input
                type="password"
                value={confirmPass}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={pass.length < 12 || pass !== confirmPass}
              onClick={download}
            >
              <Download />
              生成并下载
            </button>
          </div>
          <div>
            <h3>
              <Upload />
              上传恢复
            </h3>
            <label className="upload">
              <ArchiveRestore />
              选择 .mpbak 文件
              <input
                type="file"
                accept=".mpbak"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </label>
            <p>{file?.name || "尚未选择文件"}</p>
            <button disabled={!file || pass.length < 12} onClick={inspect}>
              检查备份
            </button>
            {summary && (
              <div className="backup-summary">
                <strong>版本 {summary.appVersion}</strong>
                <span>
                  {summary.mailboxes.length} 个邮箱 · {summary.tasks.length}{" "}
                  个任务
                </span>
                <button className="danger" onClick={restore}>
                  确认恢复
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
function TotpModal({
  data,
  onClose,
  onEnabled,
}: {
  data: any;
  onClose: () => void;
  onEnabled: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[]>();
  async function confirm() {
    const r = await api<{ recoveryCodes: string[] }>(
      "/api/v1/auth/totp/confirm",
      json("POST", { code }),
    );
    setRecovery(r.recoveryCodes);
    await onEnabled();
  }
  return (
    <Modal title="设置双重验证" onClose={onClose}>
      {!recovery ? (
        <>
          <div className="qr">
            <QRCodeSVG value={data.uri} size={190} />
            <code>{data.secret}</code>
          </div>
          <label>
            身份验证器生成的 6 位验证码
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="modal-actions">
            <button onClick={onClose}>取消</button>
            <button className="primary" onClick={confirm}>
              确认启用
            </button>
          </div>
        </>
      ) : (
        <>
          <Notice kind="danger">
            请立即保存以下一次性恢复码，关闭后不再显示。
          </Notice>
          <div className="recovery-codes">
            {recovery.map((x) => (
              <code key={x}>{x}</code>
            ))}
          </div>
          <button className="primary wide" onClick={onClose}>
            我已安全保存
          </button>
        </>
      )}
    </Modal>
  );
}
function NumberField({
  label,
  value,
  min = 1,
  max = 3650,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
function System({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function lines(v: string) {
  return v
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}
function dateInput(v?: string) {
  return v ? new Date(v).toISOString().slice(0, 10) : "";
}
