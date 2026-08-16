import { useEffect, useId, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, X } from "lucide-react";

let uiTimezone = "Asia/Shanghai";

export function setUiTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
    uiTimezone = timezone;
  } catch {
    uiTimezone = "Asia/Shanghai";
  }
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`card ${className}`}>{children}</section>;
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
export function Status({ value }: { value: string }) {
  const positive = [
    "CONNECTED",
    "RUNNING",
    "SENT",
    "ready",
    "RESOLVED",
  ].includes(value);
  const danger = [
    "AUTH_REQUIRED",
    "CIRCUIT_OPEN",
    "FAILED_CONFIRMED",
    "UNCERTAIN",
    "CRITICAL",
    "ERROR",
  ].includes(value);
  return (
    <span
      className={`status ${positive ? "positive" : danger ? "danger" : ""}`}
    >
      <span />
      {translate(value)}
    </span>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  wide?: boolean;
}) {
  const titleId = useId();
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.currentTarget === event.target && onClose?.()
      }
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {onClose && (
            <button className="icon-btn" aria-label="关闭" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" />
      正在加载
    </div>
  );
}
export function Notice({
  kind = "info",
  children,
}: {
  kind?: "info" | "danger" | "success";
  children: ReactNode;
}) {
  const Icon = kind === "danger" ? AlertTriangle : CheckCircle2;
  return (
    <div className={`notice ${kind}`}>
      <Icon size={18} />
      <span>{children}</span>
    </div>
  );
}
export function translate(value: string): string {
  return (
    (
      {
        CONNECTED: "已连接",
        AUTH_REQUIRED: "需要授权",
        DISABLED: "已停用",
        REMOVED: "已移除",
        DRAFT: "草稿",
        INITIALIZING: "初始化",
        RUNNING: "运行中",
        PAUSED: "已暂停",
        CIRCUIT_OPEN: "已熔断",
        DELETED: "已删除",
        DISCOVERED: "已发现",
        FILTERED: "已跳过",
        QUEUED: "排队中",
        CREATING_DRAFT: "创建草稿",
        DRAFT_READY: "草稿就绪",
        SENDING: "发送中",
        SENT: "服务商已接受",
        FAILED_CONFIRMED: "确认失败",
        UNCERTAIN: "状态不确定",
        OPEN: "未处理",
        ACKNOWLEDGED: "已确认",
        RESOLVED: "已恢复",
      } as Record<string, string>
    )[value] ?? value
  );
}
export function fmtDate(value?: string | Date | null): string {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: uiTimezone,
        hour12: false,
      })
    : "—";
}
export function fmtBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
