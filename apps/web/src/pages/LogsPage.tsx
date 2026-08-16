import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { api, json } from "../api";
import { useApp } from "../app-context";
import type { ProcessingLog } from "../types";
import {
  Card,
  Loading,
  Notice,
  PageHeader,
  Pagination,
  Status,
  fmtDate,
} from "../ui";
export function LogsPage() {
  const { notify } = useApp();
  const [data, setData] = useState<{
    items: ProcessingLog[];
    total: number;
    page: number;
    pageSize: number;
  }>();
  const [status, setStatus] = useState("");
  const [sender, setSender] = useState("");
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const queryParams = useCallback(
    (includePage = true) => {
      const value = new URLSearchParams();
      if (includePage) {
        value.set("page", String(page));
        value.set("pageSize", String(pageSize));
      }
      if (status) value.set("status", status);
      if (sender) value.set("sender", sender);
      if (subject) value.set("subject", subject);
      if (from) value.set("from", from);
      if (to) value.set("to", to);
      return value;
    },
    [from, page, pageSize, sender, status, subject, to],
  );
  const load = useCallback(async () => {
    setData(await api(`/api/v1/processing-logs?${queryParams().toString()}`));
  }, [queryParams]);
  useEffect(() => {
    void load();
  }, [load]);
  async function retry(id: string) {
    if (
      !confirm("仅确认未发送的失败可重试，并继续使用首次锁定的模板修订。确定？")
    )
      return;
    await api(`/api/v1/processing-logs/${id}/retry`, json("POST"));
    notify("已重新排队");
    await load();
  }
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="处理日志"
        description="发件人、主题、规则与发送状态；不保存来信正文和附件。"
        actions={
          <>
            <a
              className="button"
              href={`/api/v1/processing-logs/export?format=csv&${queryParams(false).toString()}`}
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
      <Notice>
        “服务商已接受”表示 Microsoft Graph / Gmail API
        已确认邮件进入“已发送”目录，或 SMTP
        服务器已接受邮件数据；两种情况都不等于目标邮箱已经最终投递。最终投递仍可能受对方反垃圾策略、地址规则、域名信誉或提供商延迟影响。
      </Notice>
      <Card>
        <div className="filters log-filters">
          <label>
            状态
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              {[
                "FILTERED",
                "QUEUED",
                "SENT",
                "FAILED_CONFIRMED",
                "UNCERTAIN",
              ].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label>
            发件人
            <input
              value={sender}
              onChange={(e) => {
                setSender(e.target.value);
                setPage(1);
              }}
              placeholder="邮箱关键词"
            />
          </label>
          <label>
            主题
            <input
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                setPage(1);
              }}
              placeholder="主题关键词"
            />
          </label>
          <label>
            开始日期
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </label>
          <span>共 {data.total} 条</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>邮箱</th>
                <th>发件人 / 主题</th>
                <th>文件夹</th>
                <th>事件</th>
                <th>状态</th>
                <th>原因</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((x) => (
                <tr key={x.id}>
                  <td>{fmtDate(x.occurredAt)}</td>
                  <td>{x.mailboxEmail}</td>
                  <td>
                    <strong>{x.senderEmail || "—"}</strong>
                    <small>{x.subject || "无主题"}</small>
                  </td>
                  <td>
                    {x.folder === "INBOX"
                      ? "收件箱"
                      : x.folder === "JUNKEMAIL"
                        ? "垃圾箱"
                        : "—"}
                  </td>
                  <td>{x.event}</td>
                  <td>{x.status ? <Status value={x.status} /> : null}</td>
                  <td className="reason">{x.reason || x.errorCode || "—"}</td>
                  <td>
                    {x.status === "FAILED_CONFIRMED" && x.receiptId ? (
                      <button
                        className="icon-btn"
                        title="重试"
                        onClick={() => retry(x.id)}
                      >
                        <RotateCcw />
                      </button>
                    ) : null}
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
