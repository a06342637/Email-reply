import { useCallback, useEffect, useState } from "react";
import { BellRing, Check } from "lucide-react";
import { api, json } from "../api";
import { useApp } from "../app-context";
import {
  Card,
  Empty,
  Loading,
  PageHeader,
  Pagination,
  Status,
  fmtDate,
} from "../ui";
export function AlertsPage() {
  const { notify } = useApp();
  const [data, setData] = useState<{
    items: any[];
    total: number;
    page: number;
    pageSize: number;
  }>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [status, setStatus] = useState("");
  const load = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    if (status) params.set("status", status);
    setData(await api(`/api/v1/alerts?${params.toString()}`));
  }, [page, pageSize, status]);
  useEffect(() => {
    void load();
    const events = new EventSource("/api/v1/events");
    events.onmessage = () => void load();
    const fallback = window.setInterval(() => void load(), 30_000);
    return () => {
      events.close();
      window.clearInterval(fallback);
    };
  }, [load]);
  async function ack(id: string) {
    await api(`/api/v1/alerts/${id}/acknowledge`, json("PATCH"));
    notify("告警已确认");
    await load();
  }
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="告警中心"
        description="授权失效、持续限流、熔断、Worker 和发送不确定状态。"
      />
      <Card>
        <div className="filters">
          <label>
            状态
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              <option value="OPEN">未处理</option>
              <option value="ACKNOWLEDGED">已确认</option>
              <option value="RESOLVED">已恢复</option>
            </select>
          </label>
        </div>
      </Card>
      <div className="alert-list">
        {data.items.map((a) => (
          <Card key={a.id} className={`alert-card ${a.severity.toLowerCase()}`}>
            <div className="alert-icon">
              <BellRing />
            </div>
            <div>
              <div className="title-row">
                <h2>{a.title}</h2>
                <Status value={a.status} />
              </div>
              <p>{a.message}</p>
              <small>
                {a.type} · 首次 {fmtDate(a.firstSeenAt)} · 最近{" "}
                {fmtDate(a.lastSeenAt)}
              </small>
            </div>
            {a.status === "OPEN" && (
              <button onClick={() => ack(a.id)}>
                <Check />
                确认
              </button>
            )}
          </Card>
        ))}
      </div>
      {!data.items.length && (
        <Card>
          <Empty>
            <BellRing size={38} />
            <h3>暂无告警</h3>
            <p>系统当前没有需要关注的问题。</p>
          </Empty>
        </Card>
      )}
      <Card>
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onPageChange={setPage}
          onPageSizeChange={(value) => {
            setPageSize(value);
            setPage(1);
          }}
        />
      </Card>
    </>
  );
}
