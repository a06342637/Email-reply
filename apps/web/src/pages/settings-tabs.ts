export const SETTINGS_TABS = [
  ["general", "常规"],
  ["microsoft", "Microsoft"],
  ["google", "Google / Gmail"],
  ["smtp", "SMTP 发件"],
  ["security", "登录安全"],
  ["backup", "备份恢复"],
  ["update", "在线升级"],
  ["system", "系统状态"],
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number][0];

export function resolveSettingsTab(value: string | null): SettingsTabId {
  return SETTINGS_TABS.some(([id]) => id === value)
    ? (value as SettingsTabId)
    : "general";
}

export function settingsTabHref(tab: SettingsTabId): string {
  return tab === "general" ? "/settings" : `/settings?tab=${tab}`;
}
