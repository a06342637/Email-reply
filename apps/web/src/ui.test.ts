import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PAGE_SIZE_OPTIONS, Pagination, paginationWindow } from "./ui";

describe("pagination controls", () => {
  it("offers the supported page sizes", () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([5, 10, 30, 50, 100]);
  });

  it("keeps the current page visible in a five-page window", () => {
    expect(paginationWindow(10, 1)).toEqual([1, 2, 3, 4, 5]);
    expect(paginationWindow(10, 6)).toEqual([4, 5, 6, 7, 8]);
    expect(paginationWindow(10, 10)).toEqual([6, 7, 8, 9, 10]);
  });

  it("handles short and invalid page ranges safely", () => {
    expect(paginationWindow(3, 99)).toEqual([1, 2, 3]);
    expect(paginationWindow(0, 0)).toEqual([1]);
  });

  it("renders page-size, page-number and jump controls together", () => {
    const html = renderToStaticMarkup(
      createElement(Pagination, {
        page: 3,
        pageSize: 10,
        total: 100,
        onPageChange: () => undefined,
        onPageSizeChange: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="列表分页"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("第 3 / 10 页");
    expect(html).toContain("首页");
    expect(html).toContain("末页");
    expect(html).toContain("跳转");
    for (const size of PAGE_SIZE_OPTIONS) {
      expect(html).toContain(`value="${size}"`);
    }
  });
});
