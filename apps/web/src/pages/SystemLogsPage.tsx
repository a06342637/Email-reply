import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Download, RefreshCw, Search } from "lucide-react";
import { api } from "../api";
import type { SystemLog } from "../types";
import { Card, Loading, PageHeader, Pagination, Status, fmtDate } from "../ui";

type LogResponse = {
  items: SystemLog[];
  total: number;
  page: number;
  pageSize: number;
  components: string[];
};

export function SystemLogsPage() {
  const [data, setData] = useState<LogResponse>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [level, setLevel] = useState("");
  const [component, setComponent] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params = useMemo(() => {
    const value = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    if (level) value.set("level", level);
    if (component) value.set("component", component);
    if (search) value.set("query", search);
    if (from) value.set("from", from);
    if (to) value.set("to", to);
    return value;
  }, [page, pageSize, level, component, search, from, to]);

  const load = useCallback(async () => {
    setData(await api(`/api/v1/system-logs?${params.toString()}`));
  }, [params]);

  useEffect(() => {
    void load();
  }, [load]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(query.trim());
  }

  if (!data) return <Loading />;
  const exportParams = new URLSearchParams(params);
  exportParams.delete("page");
  exportParams.delete("pageSize");
  exportParams.set("format", "csv");
  return (
    <>
      <PageHeader
        title="系统日志"
        description="Scheduler、Worker、Outbox 和 HTTP 异常日志；敏感凭据不会写入这里。"
        actions={
          <>
            <a
              className="button"
              href={`/api/v1/system-logs/export?${exportParams.toString()}`}
            >
              <Download />
              CSV
            </a>
            <button onClick={load}>
              <RefreshCw />
              刷新
            </button>
          </>
        }
      />
      <Card>
        <form className="filters log-filters" onSubmit={submit}>
          <label>
            级别
            <select
              value={level}
              onChange={(event) => {
                setLevel(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部级别</option>
              {["ERROR", "WARN", "INFO"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            组件
            <select
              value={component}
              onChange={(event) => {
                setComponent(event.target.value);
                setPage(1);
              }}
            >
              <option value="">全部组件</option>
              {data.components.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            开始日期
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label className="search-filter">
            事件、消息或请求 ID
            <span>
              <input
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入关键词"
              />
              <button className="icon-btn" type="submit" title="搜索">
                <Search size={18} />
              </button>
            </span>
          </label>
          <small>共 {data.total} 条</small>
        </form>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>级别</th>
                <th>组件 / 事件</th>
                <th>消息</th>
                <th>请求 ID</th>
                <th>上下文</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>{fmtDate(item.occurredAt)}</td>
                  <td>
                    <Status value={item.level} />
                  </td>
                  <td>
                    <strong>{item.component}</strong>
                    <small>{item.event}</small>
                  </td>
                  <td className="log-message">{item.message}</td>
                  <td>
                    <code>{item.requestId || "—"}</code>
                  </td>
                  <td>
                    <code className="metadata-code">
                      {item.metadata ? JSON.stringify(item.metadata) : "—"}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
