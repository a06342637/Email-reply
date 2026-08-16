import { useEffect, useState } from "react";
import { api } from "../api";
import { Card, Loading, PageHeader, Pagination, fmtDate } from "../ui";
export function AuditPage() {
  const [data, setData] = useState<any>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => {
    api(`/api/v1/audit-logs?page=${page}&pageSize=${pageSize}`).then(setData);
  }, [page, pageSize]);
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader
        title="管理员审计日志"
        description="登录、改密、授权、规则、模板、备份恢复和删除操作。"
      />
      <Card>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>管理员</th>
                <th>操作</th>
                <th>对象</th>
                <th>IP</th>
                <th>请求 ID</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((x: any) => (
                <tr key={x.id}>
                  <td>{fmtDate(x.occurredAt)}</td>
                  <td>{x.admin?.username || "CLI / 系统"}</td>
                  <td>
                    <strong>{x.action}</strong>
                  </td>
                  <td>
                    {x.entityType ? `${x.entityType} · ${x.entityId}` : "—"}
                  </td>
                  <td>{x.ipAddress || "—"}</td>
                  <td>
                    <code>{x.requestId || "—"}</code>
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
