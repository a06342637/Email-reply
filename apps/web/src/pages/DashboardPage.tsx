import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Clock3,
  Mail,
  Send,
  Server,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { api } from "../api";
import { Card, Loading, PageHeader, Status, fmtDate } from "../ui";

export function DashboardPage() {
  const [data, setData] = useState<any>();
  useEffect(() => {
    api("/api/v1/dashboard").then(setData);
    const id = setInterval(
      () =>
        api("/api/v1/dashboard")
          .then(setData)
          .catch(() => {}),
      15000,
    );
    return () => clearInterval(id);
  }, []);
  if (!data) return <Loading />;
  const count = (
    groups: any[] | undefined,
    key: string,
    field: "status" | "state" = "status",
  ) => groups?.find((x) => x[field] === key)?._count?._all || 0;
  const total = (groups: any[] | undefined) =>
    groups?.reduce((sum, group) => sum + (group?._count?._all || 0), 0) || 0;
  const stateSummary = (
    groups: any[] | undefined,
    stats?: {
      discovered: number;
      sent: number;
      filtered: number;
      failed: number;
    },
  ) => [
    { label: "发现", value: stats?.discovered ?? total(groups) },
    { label: "已发送", value: stats?.sent ?? count(groups, "SENT", "state") },
    {
      label: "已跳过",
      value: stats?.filtered ?? count(groups, "FILTERED", "state"),
    },
    {
      label: "失败 / 待确认",
      value:
        stats?.failed ??
        count(groups, "FAILED_CONFIRMED", "state") +
          count(groups, "UNCERTAIN", "state"),
    },
  ];
  const sent = data.stats24h?.sent ?? count(data.states24h, "SENT", "state");
  const queued = data.pendingOutbox ?? 0;
  return (
    <>
      <PageHeader
        title="运行概览"
        description="邮箱检测、回复队列和 Microsoft Graph 健康状态。"
      />
      <div className="metric-grid">
        <Metric
          icon={<Mail />}
          label="已连接邮箱"
          value={count(data.mailboxes, "CONNECTED")}
          hint="最多建议 10 个"
        />
        <Metric
          icon={<Workflow />}
          label="运行任务"
          value={count(data.tasks, "RUNNING")}
          hint={`${count(data.tasks, "PAUSED")} 个暂停`}
        />
        <Metric
          icon={<Send />}
          label="24 小时已发送"
          value={sent}
          hint={`${queued} 封处理中`}
        />
        <Metric
          icon={<AlertTriangle />}
          label="未处理告警"
          value={data.openAlerts}
          hint={data.openAlerts ? "需要关注" : "运行平稳"}
          danger={data.openAlerts > 0}
        />
      </div>
      <Card className="processing-summary">
        <div className="card-head">
          <div>
            <h2>处理统计</h2>
            <p>按发现与完成时间统计，不保存来信正文</p>
          </div>
        </div>
        <div className="processing-periods">
          {[
            {
              label: "最近 24 小时",
              groups: data.states24h,
              stats: data.stats24h,
            },
            {
              label: "最近 7 天",
              groups: data.states7d,
              stats: data.stats7d,
            },
          ].map((period) => (
            <section key={period.label}>
              <strong>{period.label}</strong>
              <div>
                {stateSummary(period.groups, period.stats).map((item) => (
                  <span key={item.label}>
                    <small>{item.label}</small>
                    <b>{item.value}</b>
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Card>
      <div className="dashboard-grid">
        <Card>
          <div className="card-head">
            <div>
              <h2>最近邮件活动</h2>
              <p>只记录元数据，不保存来信正文</p>
            </div>
          </div>
          {data.recent.length ? (
            <div className="activity-list">
              {data.recent.map((x: any) => (
                <div key={x.id}>
                  <span className="activity-icon">
                    <Mail size={16} />
                  </span>
                  <div>
                    <strong>{x.subject || "无主题"}</strong>
                    <small>
                      {x.mailboxEmail} · {fmtDate(x.occurredAt)}
                    </small>
                  </div>
                  <Status value={x.status || x.event} />
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">暂无处理记录</div>
          )}
        </Card>
        <Card>
          <div className="card-head">
            <div>
              <h2>服务状态</h2>
              <p>Worker 心跳与队列执行节点</p>
            </div>
          </div>
          <div className="service-list">
            <div>
              <Server />
              <div>
                <strong>PostgreSQL</strong>
                <small>业务数据与事务 Outbox</small>
              </div>
              <Status value="CONNECTED" />
            </div>
            <div>
              <ShieldCheck />
              <div>
                <strong>Worker</strong>
                <small>
                  {data.workers[0]
                    ? `最后心跳 ${fmtDate(data.workers[0].updatedAt)}`
                    : "尚未启动"}
                </small>
              </div>
              <Status value={data.workers[0] ? "RUNNING" : "PAUSED"} />
            </div>
            <div>
              <Clock3 />
              <div>
                <strong>任务调度</strong>
                <small>最低 3 秒，尽力而为</small>
              </div>
              <Status
                value={
                  count(data.tasks, "CIRCUIT_OPEN") ? "CIRCUIT_OPEN" : "RUNNING"
                }
              />
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
function Metric({
  icon,
  label,
  value,
  hint,
  danger,
}: {
  icon: any;
  label: string;
  value: number;
  hint: string;
  danger?: boolean;
}) {
  return (
    <Card className={`metric ${danger ? "metric-danger" : ""}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </Card>
  );
}
