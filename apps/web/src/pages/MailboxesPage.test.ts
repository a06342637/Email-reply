import { describe, expect, it } from "vitest";
import type { Mailbox, ProviderAppConfig } from "../types";
import { microsoftDialogDefaults } from "./mailbox-app-selection";

const apps: ProviderAppConfig[] = [
  {
    id: "app-1",
    name: "Primary",
    clientId: "11111111-1111-4111-8111-111111111111",
    hasClientSecret: true,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    mailboxCount: 1,
  },
  {
    id: "app-2",
    name: "Secondary",
    clientId: "22222222-2222-4222-8222-222222222222",
    hasClientSecret: true,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    mailboxCount: 1,
  },
];

function mailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: "mailbox-1",
    email: "owner@example.com",
    provider: "MICROSOFT",
    displayName: "Owner",
    status: "AUTH_REQUIRED",
    cursors: [],
    ...overrides,
  };
}

describe("microsoftDialogDefaults", () => {
  it("uses the first saved app for a new mailbox", () => {
    expect(microsoftDialogDefaults(undefined, apps)).toEqual({
      oauthAppId: "app-1",
      refreshImport: {
        appConfigId: "app-1",
        clientId: "11111111-1111-4111-8111-111111111111",
        refreshToken: "",
      },
    });
  });

  it("keeps an independent refresh-token mailbox independent", () => {
    const result = microsoftDialogDefaults(
      mailbox({
        microsoftAuthMode: "CLIENT_ID_REFRESH_TOKEN",
        microsoftClientId: "33333333-3333-4333-8333-333333333333",
        microsoftAppConfigId: null,
      }),
      apps,
    );

    expect(result.oauthAppId).toBe("app-1");
    expect(result.refreshImport).toEqual({
      appConfigId: "",
      clientId: "33333333-3333-4333-8333-333333333333",
      refreshToken: "",
    });
  });

  it("preserves the application already bound to a mailbox", () => {
    expect(
      microsoftDialogDefaults(mailbox({ microsoftAppConfigId: "app-2" }), apps),
    ).toMatchObject({
      oauthAppId: "app-2",
      refreshImport: {
        appConfigId: "app-2",
        clientId: "22222222-2222-4222-8222-222222222222",
      },
    });
  });
});
