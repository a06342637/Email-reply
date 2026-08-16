import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, AUTH_REQUIRED_EVENT } from "./api";
import type { Admin, UiSettings } from "./types";
import { AppContext } from "./app-context";
import { Shell } from "./shell";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { MailboxesPage } from "./pages/MailboxesPage";
import { TasksPage } from "./pages/TasksPage";
import { TemplatesPage } from "./pages/TemplatesPage";
import { LogsPage } from "./pages/LogsPage";
import { AlertsPage } from "./pages/AlertsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AuditPage } from "./pages/AuditPage";
import { SystemLogsPage } from "./pages/SystemLogsPage";
import { Loading, setUiTimezone } from "./ui";
import "./styles.css";

const defaultUiSettings: UiSettings = {
  siteName: "MailPilot 自动回复",
  timezone: "Asia/Shanghai",
};

function App() {
  const [admin, setAdmin] = useState<Admin | null | undefined>(undefined);
  const [uiSettings, setUiSettings] = useState<UiSettings>(defaultUiSettings);
  const [toast, setToast] = useState<{ message: string; kind: string } | null>(
    null,
  );
  const refreshMe = useCallback(async () => {
    try {
      const result = await api<{ admin: Admin }>("/api/v1/auth/me");
      setAdmin(result.admin);
    } catch {
      setAdmin(null);
    }
  }, []);
  useEffect(() => {
    const handleAuthRequired = () => setAdmin(null);
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () =>
      window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);
  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);
  useEffect(() => {
    if (!admin) return;
    void api<UiSettings>("/api/v1/settings")
      .then(setUiSettings)
      .catch(() => undefined);
  }, [admin]);
  useEffect(() => {
    setUiTimezone(uiSettings.timezone);
  }, [uiSettings.timezone]);
  const applyUiSettings = useCallback((settings: UiSettings) => {
    setUiSettings({
      siteName: settings.siteName,
      timezone: settings.timezone,
    });
  }, []);
  const notify = useCallback(
    (message: string, kind: "success" | "danger" = "success") => {
      setToast({ message, kind });
      window.setTimeout(() => setToast(null), 3500);
    },
    [],
  );
  if (admin === undefined) return <Loading />;
  return (
    <BrowserRouter>
      {admin ? (
        <AppContext.Provider
          value={{
            admin,
            uiSettings,
            refreshMe,
            applyUiSettings,
            notify,
          }}
        >
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<DashboardPage />} />
              <Route path="mailboxes" element={<MailboxesPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="templates" element={<TemplatesPage />} />
              <Route path="logs" element={<LogsPage />} />
              <Route path="system-logs" element={<SystemLogsPage />} />
              <Route path="alerts" element={<AlertsPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppContext.Provider>
      ) : (
        <Routes>
          <Route
            path="*"
            element={<LoginPage onLogin={(value) => setAdmin(value)} />}
          />
        </Routes>
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
