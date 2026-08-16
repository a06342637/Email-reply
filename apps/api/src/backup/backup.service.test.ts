import { describe, expect, it } from "vitest";
import { AppError } from "../core/http.js";
import { BackupService } from "./backup.service.js";

function payload() {
  return {
    formatVersion: 2,
    appVersion: "0.01",
    createdAt: new Date().toISOString(),
    tables: {
      microsoftConfig: null,
      mailboxes: [
        {
          id: "mailbox-1",
          email: "legacy@example.com",
          tokenCachePlain: "legacy-msal-cache",
        },
      ],
      tasks: [],
      cursors: [],
      rules: [],
      templates: [],
      revisions: [],
      assets: [],
      receipts: [],
      attempts: [],
      processingLogs: [],
      auditLogs: [],
      systemLogs: [],
      alerts: [],
      webhooks: [],
      settings: [],
    },
  };
}

describe("BackupService provider compatibility", () => {
  const service = new BackupService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it("accepts v0.01 backups that do not contain provider or Gmail tables", () => {
    expect(() => (service as any).validatePayload(payload())).not.toThrow();
  });

  it("validates Gmail cursor mailbox references when the table is present", () => {
    const data = payload();
    (data.tables as any).gmailCursors = [
      {
        id: "gmail-cursor-1",
        mailboxId: "missing-mailbox",
        historyIdPlain: "100",
      },
    ];

    const error = (() => {
      try {
        (service as any).validatePayload(data);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("BACKUP_REFERENCE_INVALID");
  });

  it("accepts a valid Microsoft Client ID + Refresh Token cache", () => {
    const data = payload();
    data.tables.mailboxes[0] = {
      ...data.tables.mailboxes[0],
      microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
      microsoftClientId: "11111111-1111-4111-8111-111111111111",
      tokenCachePlain: JSON.stringify({
        version: 1,
        refreshToken: "refresh-token-value",
        scope: "User.Read Mail.ReadWrite Mail.Send",
      }),
    };

    expect(() => (service as any).validatePayload(data)).not.toThrow();
  });

  it("rejects a manual Microsoft backup with a malformed token cache", () => {
    const data = payload();
    data.tables.mailboxes[0] = {
      ...data.tables.mailboxes[0],
      microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
      microsoftClientId: "11111111-1111-4111-8111-111111111111",
      tokenCachePlain: "not-json",
    };

    expect(() => (service as any).validatePayload(data)).toThrowError(
      expect.objectContaining({ code: "BACKUP_TOKEN_INVALID" }),
    );
  });

  it("validates mailbox references to one of multiple provider applications", () => {
    const data = payload();
    (data.tables as any).microsoftConfigs = [
      {
        id: "app-1",
        name: "Primary",
        clientId: "11111111-1111-4111-8111-111111111111",
        clientSecretPlain: "secret-value",
      },
      {
        id: "app-2",
        name: "Secondary",
        clientId: "22222222-2222-4222-8222-222222222222",
        clientSecretPlain: "secret-value-2",
      },
    ];
    data.tables.mailboxes[0] = {
      ...data.tables.mailboxes[0],
      provider: "MICROSOFT",
      microsoftAppConfigId: "app-2",
    };

    expect(() => (service as any).validatePayload(data)).not.toThrow();

    data.tables.mailboxes[0].microsoftAppConfigId = "missing-app";
    expect(() => (service as any).validatePayload(data)).toThrowError(
      expect.objectContaining({ code: "BACKUP_REFERENCE_INVALID" }),
    );
  });

  it("does not bind an old independent refresh-token mailbox to the first app", () => {
    expect(
      (service as any).restoredProviderApps(
        {},
        "MICROSOFT",
        "CLIENT_ID_REFRESH_TOKEN",
        [{ id: "app-1" }],
        [],
      ),
    ).toEqual({
      microsoftAppConfigId: null,
      googleAppConfigId: null,
    });
  });

  it("accepts an encrypted-backup SMTP config referenced by an SMTP task", () => {
    const data = payload();
    (data.tables as any).templates = [
      {
        id: "template-1",
        publishedRevisionId: null,
      },
    ];
    (data.tables as any).smtpConfigs = [
      {
        id: "smtp-1",
        name: "Transactional SMTP",
        host: "smtp.example.com",
        port: 587,
        security: "STARTTLS",
        username: "service@example.com",
        passwordPlain: "app-password",
        fromEmail: "service@example.com",
      },
    ];
    (data.tables as any).tasks = [
      {
        id: "task-1",
        mailboxId: "mailbox-1",
        defaultTemplateId: "template-1",
        sendTransport: "SMTP",
        smtpConfigId: "smtp-1",
      },
    ];

    expect(() => (service as any).validatePayload(data)).not.toThrow();
  });

  it("rejects an SMTP task whose SMTP config is absent from the backup", () => {
    const data = payload();
    (data.tables as any).tasks = [
      {
        id: "task-1",
        mailboxId: "mailbox-1",
        defaultTemplateId: null,
        sendTransport: "SMTP",
        smtpConfigId: "missing-smtp",
      },
    ];

    expect(() => (service as any).validatePayload(data)).toThrowError(
      expect.objectContaining({ code: "BACKUP_REFERENCE_INVALID" }),
    );
  });
});
