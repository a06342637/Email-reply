import { describe, expect, it, vi } from "vitest";
import { GlobalExceptionFilter } from "./http.js";

function fixture() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  const request = {
    requestId: "request-1",
    method: "POST",
    path: "/api/v1/test",
    query: {},
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  };
  return { filter: new GlobalExceptionFilter(), response, host };
}

describe("GlobalExceptionFilter", () => {
  it("returns a stable 400 error for malformed JSON", () => {
    const { filter, response, host } = fixture();
    const error = Object.assign(new SyntaxError("Unexpected token"), {
      status: 400,
      type: "entity.parse.failed",
    });

    filter.catch(error, host as never);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: "INVALID_JSON",
        message: "请求 JSON 格式无效",
        requestId: "request-1",
      },
    });
  });

  it("returns 413 when the JSON body exceeds its configured limit", () => {
    const { filter, response, host } = fixture();
    const error = Object.assign(new Error("request entity too large"), {
      status: 413,
      type: "entity.too.large",
    });

    filter.catch(error, host as never);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "请求内容超过允许大小",
        requestId: "request-1",
      },
    });
  });
});
