import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  GitCommitHorizontal,
  RefreshCw,
  RotateCcw,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { api, json } from "./api";
import { Card, Modal, Notice, fmtDate } from "./ui";

type UpdateStatus = {
  phase: string;
  busy: boolean;
  progress: number;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  message: string;
  checkedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  currentCommit: string | null;
  targetCommit: string | null;
  releaseNotes: string[];
  blockedReason: string | null;
  backupFile: string | null;
  rollbackImage: string | null;
  error: string | null;
  logs: string[];
  updaterVersion: string;
};

const PHASE_LABELS: Record<string, string> = {
  IDLE: "等待检查",
  CHECKING: "检查更新",
  AVAILABLE: "发现新版本",
  UP_TO_DATE: "已是最新版",
  QUEUED: "任务排队",
  BACKING_UP: "加密备份",
  PREPARING: "准备版本",
  BUILDING: "构建镜像",
  STOPPING: "停止旧服务",
  MIGRATING: "数据库迁移",
  STARTING: "启动新服务",
  HEALTH_CHECK: "健康检查",
  SUCCEEDED: "升级成功",
  ROLLED_BACK: "已自动回滚",
  FAILED: "操作失败",
  DISABLED: "尚未配置",
  UNAVAILABLE: "服务不可用",
};

export function UpdatePanel({
  notify,
}: {
  notify: (message: string, kind?: "success" | "danger") => void;
}) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [loading, setLoading] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(
    async (silent = false) => {
      try {
        const next = await api<UpdateStatus>("/api/v1/update/status");
        setStatus(next);
        setConnectionLost(false);
      } catch (error) {
        setConnectionLost(true);
        if (!silent)
          notify(
            error instanceof Error ? error.message : "读取升级状态失败",
            "danger",
          );
      }
    },
    [notify],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.busy) return;
    const timer = window.setInterval(() => void refresh(true), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, status?.busy]);

  async function check() {
    setLoading(true);
    try {
      const next = await api<UpdateStatus>(
        "/api/v1/update/check",
        json("POST"),
      );
      setStatus(next);
      notify(
        next.updateAvailable
          ? `发现 v${next.latestVersion}`
          : "当前已是最新版本",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "检查更新失败", "danger");
      await refresh(true);
    } finally {
      setLoading(false);
    }
  }

  if (!status)
    return (
      <Card>
        <div className="update-loading">
          <RefreshCw className="spin" /> 正在读取在线升级状态
        </div>
      </Card>
    );

  const failed = ["FAILED", "ROLLED_BACK", "UNAVAILABLE", "DISABLED"].includes(
    status.phase,
  );
  const succeeded = ["SUCCEEDED", "UP_TO_DATE"].includes(status.phase);
  return (
    <>
      <Card>
        <div className="settings-section update-panel">
          <div className="update-heading">
            <div>
              <span
                className={`update-phase ${failed ? "failed" : succeeded ? "ok" : ""}`}
              >
                {PHASE_LABELS[status.phase] || status.phase}
              </span>
              <h2>在线升级</h2>
              <p>
                只安装 GitHub 官方仓库 main
                分支上的正式版本标签，并在切换版本前自动创建加密备份。
              </p>
            </div>
            <ServerCog />
          </div>

          {connectionLost && status.busy && (
            <Notice>
              后台正在重启，连接暂时中断属于正常现象；页面会继续自动重连，请不要重复点击升级。
            </Notice>
          )}
          {status.phase === "ROLLED_BACK" && (
            <Notice kind="danger">
              新版本未通过检查，系统已经恢复升级前镜像和代码。请保留升级前备份并查看错误详情。
            </Notice>
          )}
          {status.error && <Notice kind="danger">{status.error}</Notice>}
          {status.blockedReason && (
            <Notice kind="danger">{status.blockedReason}</Notice>
          )}
          {status.phase === "SUCCEEDED" && (
            <Notice kind="success">
              新版本、数据库、Redis 与 Worker 已全部通过健康检查。
            </Notice>
          )}

          <div className="update-version-grid">
            <VersionBox
              label="当前版本"
              value={`v${status.currentVersion || "未知"}`}
            />
            <VersionBox
              label="最新正式版"
              value={
                status.latestVersion ? `v${status.latestVersion}` : "尚未检查"
              }
              accent={status.updateAvailable}
            />
            <VersionBox
              label="升级器版本"
              value={
                status.updaterVersion ? `v${status.updaterVersion}` : "不可用"
              }
            />
          </div>

          {(status.busy || status.progress > 0) && (
            <div className="update-progress-wrap">
              <div className="update-progress-head">
                <strong>{status.message}</strong>
                <span>{Math.max(0, Math.min(100, status.progress || 0))}%</span>
              </div>
              <div className="update-progress">
                <span
                  style={{
                    width: `${Math.max(0, Math.min(100, status.progress || 0))}%`,
                  }}
                />
              </div>
            </div>
          )}

          <div className="update-meta">
            {status.checkedAt && (
              <span>最近检查：{fmtDate(status.checkedAt)}</span>
            )}
            {status.backupFile && <span>升级前备份：{status.backupFile}</span>}
            {status.rollbackImage && (
              <span>回滚镜像：{status.rollbackImage}</span>
            )}
          </div>

          {status.releaseNotes?.length > 0 && (
            <div className="update-notes">
              <h3>
                <GitCommitHorizontal /> 本次更新内容
              </h3>
              <ul>
                {status.releaseNotes.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {status.logs?.length > 0 && (
            <details className="update-log">
              <summary>升级过程记录</summary>
              <div>
                {status.logs.slice(-40).map((line, index) => (
                  <code key={`${line}-${index}`}>{line}</code>
                ))}
              </div>
            </details>
          )}

          <div className="update-actions">
            <button disabled={status.busy || loading} onClick={check}>
              <RefreshCw className={status.busy || loading ? "spin" : ""} />
              {status.busy ? "升级进行中" : "检查更新"}
            </button>
            {status.updateAvailable && (
              <button
                className="primary"
                disabled={status.busy || Boolean(status.blockedReason)}
                onClick={() => setConfirming(true)}
              >
                <ShieldCheck />
                安全升级到 v{status.latestVersion}
              </button>
            )}
            {status.phase === "SUCCEEDED" && (
              <button
                className="primary soft"
                onClick={() => location.reload()}
              >
                <CheckCircle2 /> 刷新管理后台
              </button>
            )}
            {status.phase === "ROLLED_BACK" && (
              <button onClick={check}>
                <RotateCcw /> 重新检查
              </button>
            )}
          </div>
        </div>
      </Card>
      {confirming && status.latestVersion && (
        <UpgradeModal
          targetVersion={status.latestVersion}
          onClose={() => setConfirming(false)}
          onStarted={async () => {
            setConfirming(false);
            setStatus({ ...status, phase: "QUEUED", busy: true, progress: 1 });
            notify("升级任务已开始，请保持页面打开");
            await refresh(true);
          }}
        />
      )}
    </>
  );
}

function UpgradeModal({
  targetVersion,
  onClose,
  onStarted,
}: {
  targetVersion: string;
  onClose: () => void;
  onStarted: () => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmationPassphrase, setConfirmationPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const valid =
    passphrase.length >= 12 &&
    passphrase === confirmationPassphrase &&
    confirmation === "UPGRADE";

  async function start() {
    setSubmitting(true);
    setError("");
    try {
      await api(
        "/api/v1/update/apply",
        json("POST", {
          targetVersion,
          backupPassphrase: passphrase,
          confirmation,
        }),
      );
      setPassphrase("");
      setConfirmationPassphrase("");
      await onStarted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "启动升级失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={`升级到 v${targetVersion}`}
      onClose={submitting ? undefined : onClose}
    >
      <Notice>
        系统会先生成加密备份并构建镜像，然后短暂重启后台和
        Worker。期间邮件不会丢失，恢复后会继续增量处理。
      </Notice>
      {error && <Notice kind="danger">{error}</Notice>}
      <label>
        升级前备份口令（至少 12 位）
        <input
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
      </label>
      <label>
        再次输入备份口令
        <input
          type="password"
          autoComplete="new-password"
          value={confirmationPassphrase}
          onChange={(event) => setConfirmationPassphrase(event.target.value)}
        />
      </label>
      <label>
        输入 UPGRADE 确认
        <input
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      <p className="muted-copy">
        备份口令只用于本次升级前备份，不会写入数据库、升级日志或 Docker
        日志。忘记口令将无法恢复该备份。
      </p>
      <div className="modal-actions">
        <button disabled={submitting} onClick={onClose}>
          取消
        </button>
        <button
          className="primary"
          disabled={!valid || submitting}
          onClick={start}
        >
          <ShieldCheck />
          {submitting ? "正在启动" : "确认并开始升级"}
        </button>
      </div>
    </Modal>
  );
}

function VersionBox({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "accent" : ""}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
