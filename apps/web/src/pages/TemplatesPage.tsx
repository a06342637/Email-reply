import { useEffect, useState } from "react";
import {
  Code2,
  Copy,
  Eye,
  FileUp,
  FlaskConical,
  History,
  Monitor,
  Moon,
  Plus,
  Send,
  Smartphone,
  Sun,
  Trash2,
} from "lucide-react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { api, json } from "../api";
import { useApp } from "../app-context";
import type { Asset, Mailbox, Template } from "../types";
import {
  Card,
  Empty,
  Loading,
  Modal,
  PageHeader,
  fmtDate,
  fmtBytes,
} from "../ui";
const sample = {
  sender: { name: "王小明", email: "sender@example.com" },
  mailbox: { name: "客户服务", email: "service@example.com" },
  message: {
    subject: "关于订单进度的咨询",
    received_at: new Date().toISOString(),
    folder: "inbox",
  },
  rule: { name: "订单咨询" },
  system: {
    current_date: new Date().toLocaleDateString(),
    current_time: new Date().toLocaleTimeString(),
    current_datetime: new Date().toLocaleString(),
  },
};
export function TemplatesPage() {
  const { notify } = useApp();
  const [data, setData] = useState<Template[]>();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [edit, setEdit] = useState<Template | null | undefined>();
  async function load() {
    const [t, m] = await Promise.all([
      api<Template[]>("/api/v1/templates"),
      api<Mailbox[]>("/api/v1/mailboxes"),
    ]);
    setData(t);
    setMailboxes(m);
  }
  useEffect(() => {
    void load();
  }, []);
  async function removeTemplate(template: Template) {
    const references =
      (template._count?.defaultForTasks ?? 0) + (template._count?.rules ?? 0);
    const warning = references
      ? `\n\n当前仍有 ${references} 个任务或规则引用，系统会拒绝删除，需先更换对应模板。`
      : "";
    if (
      !confirm(
        `确定永久删除模板“${template.name}”吗？模板内容、全部修订和附件都会删除，且无法恢复。${warning}`,
      )
    )
      return;
    try {
      await api(`/api/v1/templates/${template.id}`, json("DELETE"));
      notify("模板已永久删除");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除模板失败", "danger");
    }
  }
  async function duplicate(id: string) {
    await api(`/api/v1/templates/${id}/duplicate`, json("POST"));
    notify("模板副本已创建");
    await load();
  }
  async function openTemplate(id: string) {
    setEdit(await api<Template>(`/api/v1/templates/${id}`));
  }
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="模板中心"
        description="富文本、HTML 源码、Liquid 变量、内嵌图片与版本发布。"
        actions={
          <button className="primary" onClick={() => setEdit(null)}>
            <Plus />
            新建模板
          </button>
        }
      />
      {data.length ? (
        <div className="template-grid">
          {data.map((t) => {
            const latest = t.revisions[0];
            return (
              <Card key={t.id} className="template-card">
                <div
                  className="template-preview"
                  dangerouslySetInnerHTML={{
                    __html: latest?.sanitizedHtml || "<p>空模板</p>",
                  }}
                />
                <div className="template-info">
                  <div>
                    <h2>{t.name}</h2>
                    <p>{t.description || "暂无描述"}</p>
                  </div>
                  <div className="revision-row">
                    <span>
                      {t.publishedRevision
                        ? `已发布 v${t.publishedRevision.version}`
                        : "尚未发布"}
                    </span>
                    <span>最新 v{latest?.version || 1}</span>
                  </div>
                  <div className="card-actions">
                    <button onClick={() => openTemplate(t.id)}>
                      <Code2 />
                      编辑
                    </button>
                    <button onClick={() => openTemplate(t.id)}>
                      <Eye />
                      预览
                    </button>
                    <button onClick={() => duplicate(t.id)}>
                      <Copy />
                      复制
                    </button>
                    <button
                      className="danger-link"
                      onClick={() => removeTemplate(t)}
                    >
                      <Trash2 />
                      删除
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty>
            <Code2 size={38} />
            <h3>还没有回复模板</h3>
            <p>创建模板并发布后，才能启动自动回复任务。</p>
            <button className="primary" onClick={() => setEdit(null)}>
              新建第一个模板
            </button>
          </Empty>
        </Card>
      )}
      {edit !== undefined && (
        <TemplateEditor
          initial={edit}
          mailboxes={mailboxes}
          onClose={() => setEdit(undefined)}
          onSaved={async () => {
            setEdit(undefined);
            await load();
            notify("模板已保存");
          }}
        />
      )}
    </>
  );
}
function TemplateEditor({
  initial,
  mailboxes,
  onClose,
  onSaved,
}: {
  initial: Template | null;
  mailboxes: Mailbox[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const full = initial;
  const latest = full?.revisions?.[0];
  const [name, setName] = useState(full?.name || "");
  const [description, setDescription] = useState(full?.description || "");
  const [subject, setSubject] = useState(
    latest?.subjectTemplate || "Re: {{ message.subject }}",
  );
  const [html, setHtml] = useState(
    latest?.htmlContent ||
      "<p>您好，{{ sender.name }}：</p><p>我们已经收到您关于“<strong>{{ message.subject }}</strong>”的邮件，会尽快处理。</p><p>此致<br>{{ mailbox.name }}</p>",
  );
  const [text, setText] = useState(latest?.textContent || "");
  const [mode, setMode] = useState<"rich" | "html">("rich");
  const [preview, setPreview] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">(
    "desktop",
  );
  const [previewTheme, setPreviewTheme] = useState<"light" | "dark">("light");
  const [assets, setAssets] = useState(latest?.assets || []);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: "编写自动回复正文…" }),
    ],
    content: html,
    onUpdate: ({ editor }) => setHtml(editor.getHTML()),
  });
  async function render() {
    setPreview(
      await api(
        "/api/v1/templates/preview/render",
        json("POST", {
          subjectTemplate: subject,
          htmlContent: html,
          textContent: text || undefined,
          variables: sample,
        }),
      ),
    );
  }
  async function save(publish = false) {
    setBusy(true);
    try {
      let id = full?.id;
      if (!id) {
        const r = await api<{ id: string }>(
          "/api/v1/templates",
          json("POST", {
            name,
            description,
            subjectTemplate: subject,
            htmlContent: html,
            textContent: text || undefined,
          }),
        );
        id = r.id;
      } else
        await api(
          `/api/v1/templates/${id}/draft`,
          json("PATCH", {
            name,
            description,
            subjectTemplate: subject,
            htmlContent: html,
            textContent: text || undefined,
          }),
        );
      if (publish) await api(`/api/v1/templates/${id}/publish`, json("POST"));
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (!full || !latest) return;
    const form = new FormData();
    form.append("file", file);
    form.append("inline", String(file.type.startsWith("image/")));
    const asset = await api<Asset>(
      `/api/v1/templates/revisions/${latest.id}/assets`,
      {
        method: "POST",
        body: form,
      },
    );
    setAssets([...assets, asset]);
    if (asset.inline && asset.contentId) {
      const image = `<img src="cid:${asset.contentId}" alt="内嵌图片" />`;
      setHtml(html + image);
      editor?.commands.insertContent(image);
    }
  }
  async function deleteAsset(assetId: string) {
    if (!confirm("确定删除这个附件？")) return;
    await api(`/api/v1/templates/assets/${assetId}`, json("DELETE"));
    setAssets(assets.filter((asset) => asset.id !== assetId));
  }
  return (
    <Modal title={full ? "编辑模板" : "新建模板"} onClose={onClose} wide>
      <div className="template-editor">
        <div className="editor-pane">
          <div className="form-grid">
            <label>
              模板名称
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              描述
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </div>
          <label>
            回复主题
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <div className="editor-toolbar">
            <div>
              <button
                className={mode === "rich" ? "active" : ""}
                onClick={() => {
                  setMode("rich");
                  editor?.commands.setContent(html);
                }}
              >
                富文本
              </button>
              <button
                className={mode === "html" ? "active" : ""}
                onClick={() => setMode("html")}
              >
                <Code2 />
                HTML
              </button>
            </div>
            <div>
              <button
                onClick={() => editor?.chain().focus().toggleBold().run()}
              >
                <b>B</b>
              </button>
              <button
                onClick={() => editor?.chain().focus().toggleItalic().run()}
              >
                <i>I</i>
              </button>
              <button
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
              >
                列表
              </button>
            </div>
          </div>
          {mode === "rich" ? (
            <EditorContent editor={editor} />
          ) : (
            <textarea
              className="html-source"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
            />
          )}
          <div className="variable-box">
            <strong>可用 Liquid 变量</strong>
            <div>
              {[
                "sender.name",
                "sender.email",
                "mailbox.name",
                "mailbox.email",
                "message.subject",
                "message.received_at",
                "message.folder",
                "rule.name",
                "system.current_date",
                "system.current_time",
                "system.current_datetime",
              ].map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    const token = `{{ ${v} }}`;
                    setHtml(html + token);
                    editor?.commands.insertContent(token);
                  }}
                >{`{{ ${v} }}`}</button>
              ))}
            </div>
          </div>
          <label>
            纯文本版本 <small>留空自动从 HTML 生成</small>
            <textarea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {full && latest && !latest.publishedAt && (
            <label className="upload">
              <FileUp />
              上传固定附件或内嵌图片
              <input
                type="file"
                onChange={(e) =>
                  e.target.files?.[0] && upload(e.target.files[0])
                }
              />
            </label>
          )}
          <div className="asset-list">
            {assets.map((a) => (
              <span key={a.id}>
                {a.fileName}
                <small>{fmtBytes(a.size)}</small>
                {latest && !latest.publishedAt && (
                  <button
                    className="icon-btn danger-link"
                    title="删除附件"
                    onClick={() => deleteAsset(a.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </span>
            ))}
          </div>
          {full && full.revisions.length > 0 && (
            <div className="revision-history">
              <strong>
                <History size={15} />
                版本记录
              </strong>
              {full.revisions.map((revision) => (
                <div key={revision.id}>
                  <span>v{revision.version}</span>
                  <small>{revision.publishedAt ? "已发布" : "草稿"}</small>
                  <time>
                    {fmtDate(revision.publishedAt || revision.createdAt)}
                  </time>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="preview-pane">
          <div className="preview-head">
            <span>
              {previewDevice === "mobile" ? <Smartphone /> : <Monitor />}
              邮件预览
            </span>
            <div className="preview-controls">
              <button
                className={previewDevice === "desktop" ? "active" : ""}
                title="桌面预览"
                onClick={() => setPreviewDevice("desktop")}
              >
                <Monitor size={15} />
              </button>
              <button
                className={previewDevice === "mobile" ? "active" : ""}
                title="移动预览"
                onClick={() => setPreviewDevice("mobile")}
              >
                <Smartphone size={15} />
              </button>
              <button
                title={
                  previewTheme === "light" ? "切换暗色预览" : "切换亮色预览"
                }
                onClick={() =>
                  setPreviewTheme(previewTheme === "light" ? "dark" : "light")
                }
              >
                {previewTheme === "light" ? (
                  <Moon size={15} />
                ) : (
                  <Sun size={15} />
                )}
              </button>
              <button onClick={render} title="刷新预览">
                <Eye size={15} />
              </button>
            </div>
          </div>
          <div className={`mail-preview ${previewDevice} ${previewTheme}`}>
            <header>
              <small>主题</small>
              <strong>{preview?.subject || subject}</strong>
            </header>
            <article
              dangerouslySetInnerHTML={{
                __html:
                  preview?.html ||
                  latest?.sanitizedHtml ||
                  "<p>点击“预览”以安全渲染当前模板。</p>",
              }}
            />
          </div>
        </div>
      </div>
      <div className="modal-actions split">
        <div>
          <button onClick={render}>
            <Eye />
            预览
          </button>
          {full && mailboxes.some((m) => m.status === "CONNECTED") && (
            <button onClick={() => setTest(true)}>
              <FlaskConical />
              测试发送
            </button>
          )}
        </div>
        <div>
          <button onClick={onClose}>取消</button>
          <button disabled={busy || !name} onClick={() => save(false)}>
            保存草稿
          </button>
          <button
            className="primary"
            disabled={busy || !name}
            onClick={() => save(true)}
          >
            {busy ? "处理中…" : "保存并发布"}
          </button>
        </div>
      </div>
      {test && full && (
        <TestModal
          template={full}
          mailboxes={mailboxes}
          onClose={() => setTest(false)}
        />
      )}
    </Modal>
  );
}
function TestModal({
  template,
  mailboxes,
  onClose,
}: {
  template: Template;
  mailboxes: Mailbox[];
  onClose: () => void;
}) {
  const [mailboxId, setMailbox] = useState(
    mailboxes.find((m) => m.status === "CONNECTED")?.id || "",
  );
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try {
      await api(
        `/api/v1/templates/${template.id}/test-send`,
        json("POST", { mailboxId, recipient }),
      );
      alert(
        "邮件服务商已接受测试邮件；这不代表目标邮箱已经最终投递，请继续检查目标邮箱并留意延迟或拦截。",
      );
      onClose();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="真实测试发送" onClose={onClose}>
      <label>
        发件邮箱
        <select value={mailboxId} onChange={(e) => setMailbox(e.target.value)}>
          {mailboxes
            .filter((m) => m.status === "CONNECTED")
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.email}
              </option>
            ))}
        </select>
      </label>
      <label>
        测试收件地址
        <input
          type="email"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
      </label>
      <div className="modal-actions">
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          onClick={send}
          disabled={busy || !recipient}
        >
          <Send />
          发送测试
        </button>
      </div>
    </Modal>
  );
}
