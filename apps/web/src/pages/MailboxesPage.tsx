import { useCallback, useEffect, useState } from "react";
import {
  CirclePause,
  KeyRound,
  MailPlus,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, json } from "../api";
import { useApp } from "../app-context";
import type { Mailbox } from "../types";
import { Card, Empty, Loading, PageHeader, Status, fmtDate } from "../ui";
export function MailboxesPage() {
  const { notify } = useApp();
  const [data, setData] = useState<Mailbox[]>();
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
  async function connect(provider: "microsoft" | "google") {
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
        description="通过 Microsoft 或 Google OAuth 授权，不保存邮箱密码。"
        actions={
          <div className="provider-connect-actions">
            <button className="primary" onClick={() => connect("microsoft")}>
              <MailPlus size={18} />
              连接 Microsoft
            </button>
            <button onClick={() => connect("google")}>
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
              openid、profile、offline_access、User.Read、Mail.ReadWrite、Mail.Send
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
                      connect(m.provider === "GOOGLE" ? "google" : "microsoft")
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
              先在系统设置中填写对应提供商的 Client ID 和 Client Secret，再连接
              Microsoft 或 Gmail 账户。
            </p>
            <div className="provider-connect-actions">
              <button className="primary" onClick={() => connect("microsoft")}>
                连接 Microsoft
              </button>
              <button onClick={() => connect("google")}>连接 Gmail</button>
            </div>
          </Empty>
        </Card>
      )}
    </>
  );
}
