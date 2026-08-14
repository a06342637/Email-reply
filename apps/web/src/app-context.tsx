import { createContext, useContext } from "react";
import type { Admin, UiSettings } from "./types";

export type AppContextValue = {
  admin: Admin;
  uiSettings: UiSettings;
  refreshMe: () => Promise<void>;
  applyUiSettings: (settings: UiSettings) => void;
  notify: (message: string, kind?: "success" | "danger") => void;
};
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("App context missing");
  return value;
}
