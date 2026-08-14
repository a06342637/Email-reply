import { useEffect, useState } from "react";
import {
  ArchiveRestore,
  CloudCog,
  Download,
  HardDrive,
  Lock,
  Save,
  ShieldCheck,
  Upload,
  Webhook,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { api, currentCsrf, json } from "../api";
import { useApp } from "../app-context";
import {
  Card,
  Loading,
  Modal,
  Notice,
  PageHeader,
  fmtBytes,
  fmtDate,
} from "../ui";
export function SettingsPage() {
  const { admin, applyUiSettings, refreshMe, notify } = useApp();
  const [data, setData] = useState<any>();
  const [ms, setMs] = useState<any>();
  const [info, setInfo] = useState<any>();
  const [tab, setTab] = useState("general");
  const [totp, setTotp] = useState<any>();
  const [disableTotp, setDisableTotp] = useState(false);
  const [totpPassword, setTotpPassword] = useState("");
  const [webhooks, setWebhooks] = useState<any[]>([]);
  async function load() {
    const [s, m, i, w] = await Promise.all([
      api("/api/v1/settings"),
      api("/api/v1/microsoft/config"),
      api("/api/v1/system/info"),
      api<any[]>("/api/v1/webhooks"),
    ]);
    setData(s);
    setMs(m);
    setInfo(i);
    setWebhooks(w);
  }
  useEffect(() => {
    void load();
  }, []);
  if (!data || !ms || !info) return <Loading />;
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
  async function saveMs() {
    await api(
      "/api/v1/microsoft/config",
      json("PATCH", {
        clientId: ms.clientId,
        clientSecret: ms.clientSecret || undefined,
        secretExpiresAt: ms.secretExpiresAt || null,
      }),
    );
    await api(
      "/api/v1/microsoft/public-url",
      json("PATCH", { publicUrl: ms.publicUrl || "" }),
    );
    notify("Microsoft 配置已保存");
    await load();
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
        description="站点、Microsoft 应用、登录安全、保留周期、备份和健康状态。"
      />
      <div className="settings-tabs">
        {[
          ["general", "常规"],
          ["microsoft", "Microsoft"],
          ["security", "登录安全"],
          ["backup", "备份恢复"],
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
            <h3>数据保存周期（天）</h3>
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
                label="审计日志"
                value={data.auditLogDays}
                onChange={(v) => setData({ ...data, auditLogDays: v })}
              />
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
              账户”。Client Secret 保存后不再回显。
            </Notice>
            <div className="form-grid">
              <label>
                Client ID
                <input
                  value={ms.clientId}
                  onChange={(e) => setMs({ ...ms, clientId: e.target.value })}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
              </label>
              <label>
                Client Secret
                <input
                  type="password"
                  value={ms.clientSecret || ""}
                  onChange={(e) =>
                    setMs({ ...ms, clientSecret: e.target.value })
                  }
                  placeholder={
                    ms.hasClientSecret
                      ? "已保存；留空不替换"
                      : "请输入 Secret Value"
                  }
                />
              </label>
              <label>
                Secret 到期日
                <input
                  type="date"
                  value={dateInput(ms.secretExpiresAt)}
                  onChange={(e) =>
                    setMs({ ...ms, secretExpiresAt: e.target.value })
                  }
                />
              </label>
              <label>
                HTTPS 公开地址
                <input
                  value={ms.publicUrl || ""}
                  onChange={(e) => setMs({ ...ms, publicUrl: e.target.value })}
                  placeholder="https://mail.example.com"
                />
              </label>
            </div>
            <div className="callback">
              <span>OAuth 回调地址</span>
              <code>{ms.callbackUrl}</code>
            </div>
            <div className="scope-list">
              {ms.scopes.map((s: string) => (
                <span key={s}>{s}</span>
              ))}
            </div>
            <button className="primary" onClick={saveMs}>
              <CloudCog />
              保存 Microsoft 配置
            </button>
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
