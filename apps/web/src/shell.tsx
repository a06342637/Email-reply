import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  Activity,
  Bell,
  BookOpenCheck,
  ChevronLeft,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Moon,
  ServerCog,
  ScrollText,
  Settings,
  Sun,
  Workflow,
} from "lucide-react";
import { api, json } from "./api";
import { useApp } from "./app-context";
import { Modal, Notice } from "./ui";

const nav = [
  ["/", "仪表盘", LayoutDashboard],
  ["/mailboxes", "邮箱账号", Mail],
  ["/tasks", "自动回复", Workflow],
  ["/templates", "模板中心", BookOpenCheck],
  ["/logs", "处理日志", ScrollText],
  ["/system-logs", "系统日志", ServerCog],
  ["/alerts", "告警中心", Bell],
  ["/audit", "审计日志", Activity],
  ["/settings", "系统设置", Settings],
] as const;

export function Shell() {
  const { admin, uiSettings, refreshMe } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [password, setPassword] = useState({ current: "", next: "" });
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(admin.theme);
    update();
    if (admin.theme === "system") media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [admin.theme]);
  useEffect(() => {
    document.title = uiSettings.siteName;
  }, [uiSettings.siteName]);
  useEffect(() => {
    if (!mobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobile]);
  async function theme() {
    const order = ["system", "dark", "light"] as const;
    const next = order[(order.indexOf(admin.theme) + 1) % 3]!;
    await api("/api/v1/auth/theme", json("PATCH", { theme: next }));
    await refreshMe();
  }
  async function logout() {
    await api("/api/v1/auth/logout", json("POST"));
    location.href = "/";
  }
  async function changeRequiredPassword() {
    await api(
      "/api/v1/auth/password",
      json("POST", {
        currentPassword: password.current,
        newPassword: password.next,
      }),
    );
    location.href = "/";
  }
  const ThemeIcon =
    admin.theme === "dark" ? Moon : admin.theme === "light" ? Sun : Sun;
  return (
    <div className={`app-shell ${collapsed ? "collapsed" : ""}`}>
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            {uiSettings.siteName.trim().slice(0, 1).toUpperCase() || "M"}
          </div>
          <div>
            <strong title={uiSettings.siteName}>{uiSettings.siteName}</strong>
            <span>邮箱自动回复</span>
          </div>
        </div>
        <nav>
          {nav.map(([to, label, Icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setMobile(false)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button onClick={() => setCollapsed(!collapsed)}>
            <ChevronLeft size={18} />
            <span>折叠导航</span>
          </button>
        </div>
      </aside>
      {mobile && (
        <div className="drawer-mask" onClick={() => setMobile(false)} />
      )}
      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-btn mobile-menu"
            aria-label="打开导航"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <div className="topbar-title">
            <span className="live-dot" />
            系统控制台
          </div>
          <div className="topbar-actions">
            <button
              className="icon-btn"
              aria-label={`切换主题，当前：${admin.theme}`}
              title={`主题：${admin.theme}`}
              onClick={theme}
            >
              <ThemeIcon size={19} />
            </button>
            <div className="admin-chip">
              <span>{admin.username.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{admin.username}</strong>
                <small>超级管理员</small>
              </div>
            </div>
            <button className="icon-btn" aria-label="退出登录" onClick={logout}>
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </main>
      {admin.mustChangePassword && (
        <Modal title="首次登录：修改临时密码">
          <Notice kind="danger">
            安装时随机生成的临时密码必须立即替换，完成前不能使用其他后台功能。
          </Notice>
          <label>
            当前临时密码
            <input
              type="password"
              value={password.current}
              onChange={(e) =>
                setPassword({ ...password, current: e.target.value })
              }
            />
          </label>
          <label>
            新密码（至少 12 位）
            <input
              type="password"
              value={password.next}
              onChange={(e) =>
                setPassword({ ...password, next: e.target.value })
              }
            />
          </label>
          <button
            className="primary wide"
            disabled={!password.current || password.next.length < 12}
            onClick={changeRequiredPassword}
          >
            修改密码并重新登录
          </button>
        </Modal>
      )}
    </div>
  );
}

function applyTheme(theme: string) {
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
