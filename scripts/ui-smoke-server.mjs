import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "apps", "web", "dist");
const port = Number(process.env.UI_SMOKE_PORT || 4174);
const now = new Date().toISOString();
let adminTheme = "dark";
let mailboxRemoved = false;
let taskDeleted = false;
let smokeSettings = {
  siteName: "MailPilot 自动回复",
  timezone: "Asia/Shanghai",
  defaultPollIntervalSeconds: 30,
  defaultBacklogPerMinute: 20,
  excludedAddresses: [],
  excludedDomains: [],
  attachmentLimitMb: 10,
  processingLogDays: 30,
  systemLogDays: 30,
  auditLogDays: 180,
  dedupeDays: 365,
  sessionIdleMinutes: 120,
  sessionAbsoluteMinutes: 720,
  version: "0.04",
};

const template = {
  id: "template-1",
  name: "客户咨询自动回复",
  description: "UI 冒烟测试模板",
  publishedRevisionId: "revision-1",
  publishedRevision: { id: "revision-1", version: 1, publishedAt: now },
  revisions: [
    {
      id: "revision-2",
      version: 2,
      subjectTemplate: "Re: {{ message.subject }}",
      htmlContent: "<p>您好，{{ sender.name }}，我们已经收到您的邮件。</p>",
      sanitizedHtml: "<p>您好，{{ sender.name }}，我们已经收到您的邮件。</p>",
      textContent: "您好，我们已经收到您的邮件。",
      createdAt: now,
      assets: [
        {
          id: "asset-1",
          fileName: "service-guide.pdf",
          contentType: "application/pdf",
          size: 2048,
          inline: false,
        },
      ],
    },
    {
      id: "revision-1",
      version: 1,
      subjectTemplate: "Re: {{ message.subject }}",
      htmlContent: "<p>已收到您的邮件。</p>",
      sanitizedHtml: "<p>已收到您的邮件。</p>",
      textContent: "已收到您的邮件。",
      createdAt: now,
      publishedAt: now,
      assets: [],
    },
  ],
  _count: { rules: 1, defaultForTasks: 1 },
};

const mailbox = {
  id: "mailbox-1",
  email: "service@example.com",
  provider: "MICROSOFT",
  microsoftAuthMode: "MSAL_OAUTH",
  microsoftClientId: null,
  displayName: "客户服务",
  tenantId: "tenant-1",
  accountType: "MICROSOFT_365",
  status: "CONNECTED",
  lastTokenRefreshAt: now,
  cursors: [
    { folder: "INBOX", lastSuccessfulAt: now, initializedAt: now },
    { folder: "JUNKEMAIL", lastSuccessfulAt: now, initializedAt: now },
  ],
  task: {
    id: "task-1",
    name: "客户服务自动回复",
    status: "RUNNING",
    pollIntervalSeconds: 10,
    backlogPerMinute: 20,
    defaultTemplateId: "template-1",
    averagePollLatencyMs: 420,
    nextPollAt: now,
    lastPollCompletedAt: now,
    _count: { receipts: 2 },
    defaultTemplate: {
      id: "template-1",
      name: template.name,
      publishedRevisionId: "revision-1",
    },
    rules: [
      {
        id: "rule-1",
        name: "订单咨询",
        enabled: true,
        templateId: "template-1",
        priority: 0,
        conditions: {
          folders: ["INBOX".toLowerCase()],
          senderAddresses: ["vip@example.net"],
          senderDomains: ["example.net"],
          subjectContains: ["订单"],
          subjectNotContains: ["已关闭"],
          subjectPrefixes: ["咨询："],
        },
        template: { name: template.name },
      },
    ],
  },
};

const gmailMailbox = {
  id: "mailbox-google-1",
  email: "support.demo@gmail.com",
  provider: "GOOGLE",
  displayName: "Gmail 支持邮箱",
  accountType: "GMAIL_PERSONAL",
  status: "CONNECTED",
  lastTokenRefreshAt: now,
  cursors: [],
  gmailCursor: {
    lastSuccessfulAt: now,
    initializedAt: now,
    highWaterAt: now,
  },
  task: null,
};

const manualMicrosoftMailbox = {
  id: "mailbox-microsoft-manual-1",
  email: "manual@example.com",
  provider: "MICROSOFT",
  microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
  microsoftClientId: "11111111-1111-4111-8111-111111111111",
  displayName: "独立授权邮箱",
  tenantId: null,
  accountType: "PERSONAL",
  status: "CONNECTED",
  lastTokenRefreshAt: now,
  cursors: [
    { folder: "INBOX", lastSuccessfulAt: now, initializedAt: now },
    { folder: "JUNKEMAIL", lastSuccessfulAt: now, initializedAt: now },
  ],
  task: null,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/v1/events") return eventStream(req, res);
  if (url.pathname.startsWith("/api/")) {
    const body = await readJson(req);
    return api(url.pathname, req.method || "GET", body, res);
  }
  const candidate = normalize(url.pathname).replace(/^([/\\])+/, "");
  const file = join(root, candidate || "index.html");
  try {
    const info = await stat(file);
    if (info.isFile()) return sendFile(file, res);
  } catch {}
  return sendFile(join(root, "index.html"), res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`UI smoke server listening on http://127.0.0.1:${port}`);
});

function api(path, method, body, res) {
  const page = (items) => ({
    items,
    page: 1,
    pageSize: 50,
    total: items.length,
  });
  if (path === "/api/v1/auth/me")
    return json(res, {
      admin: {
        id: "admin-1",
        username: "admin_demo",
        mustChangePassword: false,
        theme: adminTheme,
        totpEnabled: true,
      },
      totpEnabled: true,
    });
  if (path === "/api/v1/auth/theme" && method === "PATCH") {
    if (["dark", "light", "system"].includes(body?.theme))
      adminTheme = body.theme;
    return json(res, { theme: adminTheme });
  }
  if (path === "/api/v1/dashboard")
    return json(res, {
      mailboxes: [{ status: "CONNECTED", _count: { _all: 2 } }],
      tasks: [{ status: "RUNNING", _count: { _all: 1 } }],
      states24h: [{ state: "SENT", _count: { _all: 18 } }],
      states7d: [{ state: "SENT", _count: { _all: 72 } }],
      stats24h: { discovered: 25, sent: 18, filtered: 5, failed: 2 },
      stats7d: { discovered: 94, sent: 72, filtered: 18, failed: 4 },
      openAlerts: 0,
      workers: [{ id: "worker-1", updatedAt: now, healthy: true }],
      recent: [
        {
          id: "log-1",
          mailboxEmail: mailbox.email,
          senderEmail: "customer@example.net",
          subject: "订单咨询",
          event: "REPLY_SENT",
          status: "SENT",
          occurredAt: now,
        },
      ],
      pendingOutbox: 2,
    });
  if (path === "/api/v1/mailboxes") {
    if (mailboxRemoved) return json(res, []);
    return json(res, [
      { ...mailbox, task: taskDeleted ? null : mailbox.task },
      gmailMailbox,
      manualMicrosoftMailbox,
    ]);
  }
  if (path === "/api/v1/microsoft/import-refresh-token" && method === "POST")
    return json(res, {
      mailboxId: "mailbox-imported-1",
      email: "imported@example.com",
      displayName: "导入测试邮箱",
      authMode: "CLIENT_ID_REFRESH_TOKEN",
    });
  if (path === "/api/v1/mailboxes/mailbox-1" && method === "DELETE") {
    mailboxRemoved = true;
    return json(res, { ok: true });
  }
  if (path === "/api/v1/tasks/task-1" && method === "DELETE") {
    taskDeleted = true;
    return json(res, { ok: true });
  }
  if (/\/(?:remove|delete)$/.test(path))
    return json(
      res,
      { error: { code: "NOT_FOUND", message: `Invalid route: ${path}` } },
      404,
    );
  if (path === "/api/v1/templates/template-1") return json(res, template);
  if (path === "/api/v1/templates")
    return json(res, [{ ...template, revisions: [template.revisions[0]] }]);
  if (path === "/api/v1/templates/preview/render")
    return json(res, {
      subject: String(body?.subjectTemplate || "Re: 测试主题").replace(
        "{{ message.subject }}",
        "关于订单进度的咨询",
      ),
      html: String(body?.htmlContent || "<p>预览内容</p>").replace(
        "{{ sender.name }}",
        "王小明",
      ),
      text: String(body?.textContent || "预览内容"),
    });
  if (path === "/api/v1/settings") {
    if (method === "PATCH")
      smokeSettings = { ...smokeSettings, ...(body ?? {}) };
    return json(res, smokeSettings);
  }
  if (path === "/api/v1/microsoft/config")
    return json(res, {
      configured: true,
      clientId: "00000000-0000-4000-8000-000000000001",
      hasClientSecret: true,
      publicUrl: "https://mail.example.com",
      callbackUrl: "https://mail.example.com/api/v1/microsoft/oauth/callback",
      scopes: [
        "openid",
        "profile",
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
        "Mail.Send",
      ],
    });
  if (path === "/api/v1/google/config")
    return json(res, {
      configured: true,
      clientId: "123456789-example.apps.googleusercontent.com",
      hasClientSecret: true,
      publicUrl: "https://mail.example.com",
      callbackUrl: "https://mail.example.com/api/v1/google/oauth/callback",
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
    });
  if (path === "/api/v1/system/info")
    return json(res, {
      version: "0.04",
      node: process.version,
      database: true,
      redis: true,
      healthyWorkers: 1,
      workers: [{ id: "worker-1", updatedAt: now }],
      taskBacklog: 2,
      databaseSize: 12_345_678,
      disk: { total: 100_000_000_000, free: 80_000_000_000 },
    });
  if (path === "/api/v1/webhooks") return json(res, []);
  if (path === "/api/v1/alerts") return json(res, []);
  if (path === "/api/v1/processing-logs") return json(res, page([]));
  if (path === "/api/v1/system-logs")
    return json(res, { ...page([]), components: [] });
  if (path === "/api/v1/audit-logs") return json(res, page([]));
  if (method !== "GET") return json(res, { ok: true });
  return json(res, { error: { code: "NOT_FOUND", message: path } }, 404);
}

async function readJson(req) {
  if (["GET", "HEAD"].includes(req.method || "GET")) return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function sendFile(file, res) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  const data = await readFile(file);
  res.writeHead(200, {
    "content-type": types[extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(data);
}

function json(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function eventStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "smoke.ready" })}\n\n`);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  req.on("close", () => clearInterval(heartbeat));
}
