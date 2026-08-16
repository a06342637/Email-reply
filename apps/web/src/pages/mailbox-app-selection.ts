import type { Mailbox, ProviderAppConfig } from "../types";

export function microsoftDialogDefaults(
  mailbox: Mailbox | undefined,
  apps: ProviderAppConfig[],
) {
  const firstApp = apps[0];
  const boundApp = mailbox?.microsoftAppConfigId
    ? apps.find((app) => app.id === mailbox.microsoftAppConfigId)
    : undefined;
  const oauthApp = boundApp || firstApp;
  const refreshApp = mailbox ? boundApp : firstApp;
  return {
    oauthAppId: oauthApp?.id || "",
    refreshImport: {
      appConfigId: refreshApp?.id || "",
      clientId: refreshApp?.clientId || mailbox?.microsoftClientId || "",
      refreshToken: "",
    },
  };
}
