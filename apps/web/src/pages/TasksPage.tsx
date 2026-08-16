import { useEffect, useState } from "react";
import {
  CirclePause,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Play,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { api, json } from "../api";
import { useApp } from "../app-context";
import type { Mailbox, Rule, SmtpConfig, Template } from "../types";
import { writableRules } from "./task-utils";
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

export function TasksPage() {
  const { notify } = useApp();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [smtpConfigs, setSmtpConfigs] = useState<SmtpConfig[]>([]);
  const [defaults, setDefaults] = useState({ poll: 30, rate: 20 });
  const [editing, setEditing] = useState<Mailbox | null>(null);
  async function load() {
    const [m, t, settings, smtp] = await Promise.all([
      api<Mailbox[]>("/api/v1/mailboxes"),
      api<Template[]>("/api/v1/templates"),
      api<{
        defaultPollIntervalSeconds: number;
        defaultBacklogPerMinute: number;
      }>("/api/v1/settings"),
      api<SmtpConfig[]>("/api/v1/smtp/configs"),
    ]);
    setMailboxes(m);
    setTemplates(t);
    setSmtpConfigs(smtp);
    setDefaults({
      poll: settings.defaultPollIntervalSeconds,
      rate: settings.defaultBacklogPerMinute,
    });
  }
  useEffect(() => {
    void load();
  }, []);
  async function action(id: string, name: string) {
    if (
      name === "delete" &&
      !confirm(
        "删除任务会清除规则和 Delta 游标。以后重建任务不会补回旧任务期间的邮件。确定？",
      )
    )
      return;
    const path =
      name === "delete" ? `/api/v1/tasks/${id}` : `/api/v1/tasks/${id}/${name}`;
    await api(path, json(name === "delete" ? "DELETE" : "POST"));
    notify("任务状态已更新");
    await load();
  }
  if (!mailboxes) return <Loading />;
  const available = mailboxes.filter(
    (m) => m.status === "CONNECTED" && !m.task,
  );
  return (
    <>
      <PageHeader
        title="自动回复任务"
        description="每个邮箱一个任务，全天检测收件箱和垃圾箱。"
        actions={
          <button
            className="primary"
            disabled={
              !available.length || !templates.some((t) => t.publishedRevisionId)
            }
            onClick={() => setEditing(available[0] || null)}
          >
            <Plus />
            创建任务
          </button>
        }
      />
      <div className="task-list">
        {mailboxes
          .filter((m) => m.task)
          .map((m) => {
            const t = m.task!;
            return (
              <Card key={t.id} className="task-card">
                <div className="task-main">
                  <div className="mail-avatar">{m.displayName.slice(0, 1)}</div>
                  <div>
                    <div className="title-row">
                      <h2>{t.name}</h2>
                      <Status value={t.status} />
                    </div>
                    <p>{m.email}</p>
                    <div className="task-meta">
                      <span>
                        检测周期 <b>{t.pollIntervalSeconds}s</b>
                      </span>
                      <span>
                        积压限速 <b>{t.backlogPerMinute}/分钟</b>
                      </span>
                      <span>
                        发件通道{" "}
                        <b>
                          {t.sendTransport === "SMTP"
                            ? `SMTP · ${t.smtpConfig?.name || "配置缺失"}`
                            : "邮箱服务商 API"}
                        </b>
                      </span>
                      <span>
                        平均轮询耗时{" "}
                        <b>
                          {t.averagePollLatencyMs
                            ? `${t.averagePollLatencyMs}ms`
                            : "—"}
                        </b>
                      </span>
                      <span>
                        下次检测 <b>{fmtDate(t.nextPollAt)}</b>
                      </span>
                      <span>
                        任务积压 <b>{t._count?.receipts ?? 0}</b>
                      </span>
                      {t.graphBackoffUntil && (
                        <span>
                          服务退避至 <b>{fmtDate(t.graphBackoffUntil)}</b>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="task-actions">
                  {["DRAFT", "PAUSED", "CIRCUIT_OPEN"].includes(t.status) ? (
                    <button
                      className="primary soft"
                      onClick={() =>
                        action(t.id, t.status === "DRAFT" ? "start" : "resume")
                      }
                    >
                      <Play />
                      运行
                    </button>
                  ) : (
                    <button onClick={() => action(t.id, "pause")}>
                      <CirclePause />
                      暂停
                    </button>
                  )}
                  <button onClick={() => setEditing(m)}>
                    <Settings2 />
                    配置
                  </button>
                  <button
                    className="danger-link"
                    onClick={() => action(t.id, "delete")}
                  >
                    <Trash2 />
                    删除
                  </button>
                </div>
              </Card>
            );
          })}
      </div>
      {!mailboxes.some((m) => m.task) && (
        <Card>
          <Empty>
            <Settings2 size={38} />
            <h3>尚未创建任务</h3>
            <p>先发布至少一个模板，然后为已连接邮箱创建自动回复任务。</p>
          </Empty>
        </Card>
      )}
      {editing && (
        <TaskEditor
          mailbox={editing}
          templates={templates}
          smtpConfigs={smtpConfigs}
          defaults={defaults}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            notify("任务配置已保存");
          }}
        />
      )}
    </>
  );
}
function TaskEditor({
  mailbox,
  templates,
  smtpConfigs,
  defaults,
  onClose,
  onSaved,
}: {
  mailbox: Mailbox;
  templates: Template[];
  smtpConfigs: SmtpConfig[];
  defaults: { poll: number; rate: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { notify } = useApp();
  const task = mailbox.task;
  const [name, setName] = useState(
    task?.name || `${mailbox.displayName} 自动回复`,
  );
  const [poll, setPoll] = useState(task?.pollIntervalSeconds || defaults.poll);
  const [rate, setRate] = useState(task?.backlogPerMinute || defaults.rate);
  const [template, setTemplate] = useState(
    task?.defaultTemplateId ||
      templates.find((t) => t.publishedRevisionId)?.id ||
      "",
  );
  const [rules, setRules] = useState<Rule[]>(task?.rules || []);
  const [sendTransport, setSendTransport] = useState<"MAILBOX_API" | "SMTP">(
    task?.sendTransport || "MAILBOX_API",
  );
  const [smtpConfigId, setSmtpConfigId] = useState(
    task?.smtpConfigId || smtpConfigs[0]?.id || "",
  );
  const [busy, setBusy] = useState(false);
  const [draggingRule, setDraggingRule] = useState<number | null>(null);
  async function save() {
    setBusy(true);
    try {
      let id = task?.id;
      if (id)
        await api(
          `/api/v1/tasks/${id}`,
          json("PATCH", {
            name,
            pollIntervalSeconds: Number(poll),
            backlogPerMinute: Number(rate),
            defaultTemplateId: template,
            sendTransport,
            smtpConfigId: sendTransport === "SMTP" ? smtpConfigId : null,
          }),
        );
      else {
        id = (
          await api<{ id: string }>(
            `/api/v1/mailboxes/${mailbox.id}/task`,
            json("POST", {
              name,
              pollIntervalSeconds: Number(poll),
              backlogPerMinute: Number(rate),
              defaultTemplateId: template,
              sendTransport,
              smtpConfigId: sendTransport === "SMTP" ? smtpConfigId : null,
            }),
          )
        ).id;
      }
      await api(
        `/api/v1/tasks/${id}/rules`,
        json("PATCH", { rules: writableRules(rules) }),
      );
      onSaved();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "任务配置保存失败",
        "danger",
      );
    } finally {
      setBusy(false);
    }
  }
  function addRule() {
    setRules([
      ...rules,
      {
        name: `规则 ${rules.length + 1}`,
        enabled: true,
        templateId: template,
        conditions: {},
      },
    ]);
  }
  function values(v: string) {
    return v
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  }
  function updateRule(index: number, change: Partial<Rule>) {
    setRules(
      rules.map((rule, i) => (i === index ? { ...rule, ...change } : rule)),
    );
  }
  function updateCondition(index: number, key: string, value: string[]) {
    const rule = rules[index]!;
    updateRule(index, {
      conditions: { ...rule.conditions, [key]: value },
    });
  }
  function moveRule(from: number, to: number) {
    if (from === to || to < 0 || to >= rules.length) return;
    const next = [...rules];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setRules(next);
  }
  return (
    <Modal
      title={task ? "配置自动回复任务" : "创建自动回复任务"}
      onClose={onClose}
      wide
    >
      <div className="form-grid">
        <label>
          任务名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          检测周期（秒）
          <input
            type="number"
            min="3"
            max="3600"
            value={poll}
            onChange={(e) => setPoll(Number(e.target.value))}
          />
        </label>
        <label>
          积压发送上限（每分钟）
          <input
            type="number"
            min="1"
            max="300"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </label>
        <label>
          默认模板
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            {templates
              .filter((t) => t.publishedRevisionId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          发件通道
          <select
            value={sendTransport}
            onChange={(event) =>
              setSendTransport(event.target.value as "MAILBOX_API" | "SMTP")
            }
          >
            <option value="MAILBOX_API">邮箱服务商 API（Graph / Gmail）</option>
            <option value="SMTP">SMTP 发件</option>
          </select>
        </label>
        {sendTransport === "SMTP" && (
          <label>
            SMTP 配置
            <select
              value={smtpConfigId}
              onChange={(event) => setSmtpConfigId(event.target.value)}
            >
              <option value="">请选择 SMTP 配置</option>
              {smtpConfigs.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.name} · {config.fromEmail}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {Number(poll) <= 5 && (
        <Notice>
          3–5 秒属于高频尽力轮询：不会因为设置本身违反 Microsoft 或 Google
          协议，但更容易触发 API 限流。系统会遵守
          Retry-After、自动指数退避并禁止重叠轮询；稳定运行建议使用 10–30 秒。
        </Notice>
      )}
      {sendTransport === "SMTP" && !smtpConfigs.length && (
        <Notice kind="danger">
          尚未配置 SMTP。请先到“系统设置 → SMTP 发件”添加并测试配置。
        </Notice>
      )}
      <div className="section-title">
        <div>
          <h3>优先级规则</h3>
          <p>从上到下，第一条匹配规则生效；不同条件 AND，同类多值 OR。</p>
        </div>
        <button onClick={addRule}>
          <Plus />
          添加规则
        </button>
      </div>
      <div className="rule-stack">
        {rules.map((r, i) => (
          <div
            className={`rule-editor ${draggingRule === i ? "dragging" : ""}`}
            key={r.id || i}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (draggingRule !== null) moveRule(draggingRule, i);
              setDraggingRule(null);
            }}
          >
            <div className="rule-order-block">
              <button
                className="rule-drag"
                title="拖拽调整优先级"
                draggable
                onDragStart={() => setDraggingRule(i)}
                onDragEnd={() => setDraggingRule(null)}
              >
                <GripVertical size={17} />
              </button>
              <span className="rule-order">{i + 1}</span>
              <div className="rule-move-buttons">
                <button
                  title="上移规则"
                  disabled={i === 0}
                  onClick={() => moveRule(i, i - 1)}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  title="下移规则"
                  disabled={i === rules.length - 1}
                  onClick={() => moveRule(i, i + 1)}
                >
                  <ChevronDown size={13} />
                </button>
              </div>
            </div>
            <div className="rule-fields">
              <div className="form-grid compact">
                <label>
                  规则名
                  <input
                    value={r.name}
                    onChange={(e) => updateRule(i, { name: e.target.value })}
                  />
                </label>
                <label>
                  模板
                  <select
                    value={r.templateId}
                    onChange={(e) =>
                      updateRule(i, { templateId: e.target.value })
                    }
                  >
                    {templates
                      .filter((t) => t.publishedRevisionId)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="rule-enabled">
                  规则状态
                  <span>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) =>
                        updateRule(i, { enabled: e.target.checked })
                      }
                    />
                    {r.enabled ? "启用" : "停用"}
                  </span>
                </label>
                <fieldset className="folder-options">
                  <legend>文件夹（可多选）</legend>
                  {["inbox", "junkemail"].map((folder) => (
                    <label key={folder}>
                      <input
                        type="checkbox"
                        checked={(r.conditions.folders || []).includes(folder)}
                        onChange={(e) => {
                          const selected = new Set(r.conditions.folders || []);
                          if (e.target.checked) selected.add(folder);
                          else selected.delete(folder);
                          updateCondition(i, "folders", [...selected]);
                        }}
                      />
                      {folder === "inbox" ? "收件箱" : "垃圾箱"}
                    </label>
                  ))}
                </fieldset>
                <label>
                  发件人完整地址
                  <textarea
                    rows={2}
                    placeholder="每行一个邮箱地址"
                    value={(r.conditions.senderAddresses || []).join("\n")}
                    onChange={(e) =>
                      updateCondition(
                        i,
                        "senderAddresses",
                        values(e.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  发件人域名
                  <textarea
                    rows={2}
                    placeholder="每行一个域名"
                    value={(r.conditions.senderDomains || []).join("\n")}
                    onChange={(e) =>
                      updateCondition(
                        i,
                        "senderDomains",
                        values(e.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  主题包含
                  <textarea
                    rows={2}
                    placeholder="每行一个关键词"
                    value={(r.conditions.subjectContains || []).join("\n")}
                    onChange={(e) =>
                      updateCondition(
                        i,
                        "subjectContains",
                        values(e.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  主题不包含
                  <textarea
                    rows={2}
                    placeholder="每行一个排除关键词"
                    value={(r.conditions.subjectNotContains || []).join("\n")}
                    onChange={(e) =>
                      updateCondition(
                        i,
                        "subjectNotContains",
                        values(e.target.value),
                      )
                    }
                  />
                </label>
                <label>
                  主题前缀
                  <textarea
                    rows={2}
                    placeholder="每行一个前缀"
                    value={(r.conditions.subjectPrefixes || []).join("\n")}
                    onChange={(e) =>
                      updateCondition(
                        i,
                        "subjectPrefixes",
                        values(e.target.value),
                      )
                    }
                  />
                </label>
              </div>
            </div>
            <button
              className="icon-btn danger-link"
              onClick={() => setRules(rules.filter((_, n) => n !== i))}
            >
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          disabled={
            busy || !template || (sendTransport === "SMTP" && !smtpConfigId)
          }
          onClick={save}
        >
          {busy ? "保存中…" : "保存配置"}
        </button>
      </div>
    </Modal>
  );
}
