import { describe, expect, it } from "@jest/globals";
import {
  MAX_EXTERNAL_IDENTIFIER_LENGTH,
  assessOrderPage,
  externalIdentifierProblem,
  orderPageResult,
} from "../../src/mcp-server/order-recovery.js";
import { buildOrderBody } from "../../src/mcp-server/index.js";

describe("externalIdentifierProblem", () => {
  it.each([
    undefined,
    "a",
    "intent-0001",
    "a b",
    "x".repeat(MAX_EXTERNAL_IDENTIFIER_LENGTH),
    "!~",
  ])("accepts %p", (value) => {
    expect(externalIdentifierProblem(value)).toBeUndefined();
  });

  it.each([
    [null, /must be a string; received null/],
    [7, /must be a string; received number/],
    ["", /must not be empty/],
    ["x".repeat(MAX_EXTERNAL_IDENTIFIER_LENGTH + 1), /the limit is 255/],
    [" lead", /printable ASCII/],
    ["trail ", /printable ASCII/],
    ["tab\there", /printable ASCII/],
    ["ünïcode", /printable ASCII/],
  ])("refuses %p", (value, why) => {
    expect(externalIdentifierProblem(value)).toMatch(why);
  });
});

describe("buildOrderBody and external_identifier", () => {
  const base = { time_in_force: "Day", order_type: "Market", legs: [] };

  it("sends the identifier unchanged as external-identifier", () => {
    expect(
      buildOrderBody({ ...base, external_identifier: "abc-123" })[
        "external-identifier"
      ],
    ).toBe("abc-123");
  });

  it("omits the key when no identifier is given", () => {
    expect(buildOrderBody(base)).not.toHaveProperty("external-identifier");
  });
});

describe("assessOrderPage", () => {
  const page = (p: Record<string, unknown>) => p;

  it("is unknown when the items are not an array", () => {
    const v = assessOrderPage({ not: "array" }, page({}));
    expect(v.verdict).toBe("unknown");
    expect(v.items_returned).toBeNull();
  });

  it.each([undefined, null])("is unknown with pagination %p", (p) => {
    const v = assessOrderPage([], p);
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toMatch(/no pagination metadata/);
    expect(v.items_returned).toBe(0);
  });

  it.each(["page 1", 3, [1, 2]])(
    "is unknown with non-object pagination %p",
    (p) => {
      expect(assessOrderPage([], p).verdict).toBe("unknown");
    },
  );

  it.each([
    [{ "total-pages": 1, "page-offset": 0 }, "total-items"],
    [{ "total-items": 1, "page-offset": 0 }, "total-pages"],
    [{ "total-items": 1, "total-pages": 1 }, "page-offset"],
    [{ "total-items": "1", "total-pages": 1, "page-offset": 0 }, "total-items"],
    [{ "total-items": -1, "total-pages": 1, "page-offset": 0 }, "total-items"],
    [{ "total-items": 1.5, "total-pages": 1, "page-offset": 0 }, "total-items"],
  ])("is unknown when a required field is unusable: %p", (p, field) => {
    const v = assessOrderPage([{}], p);
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toContain(field);
  });

  it.each([0, -1, "10"])(
    "is unknown with an unusable per-page %p",
    (perPage) => {
      const v = assessOrderPage([], {
        "total-items": 0,
        "total-pages": 0,
        "page-offset": 0,
        "per-page": perPage,
      });
      expect(v.verdict).toBe("unknown");
      expect(v.reason).toMatch(/per-page/);
    },
  );

  it("is unknown when current-item-count disagrees with what arrived", () => {
    const v = assessOrderPage([{}], {
      "total-items": 2,
      "total-pages": 1,
      "page-offset": 0,
      "current-item-count": 2,
    });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toMatch(/holds 2 orders but 1 arrived/);
  });

  it("is unknown when total-pages contradicts total-items and per-page", () => {
    const v = assessOrderPage([{}], {
      "total-items": 25,
      "total-pages": 1,
      "page-offset": 0,
      "per-page": 10,
    });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toMatch(/is 3 pages, not 1/);
  });

  it("is unknown when a single page holds fewer orders than the total", () => {
    const v = assessOrderPage([{}], {
      "total-items": 2,
      "total-pages": 1,
      "page-offset": 0,
    });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toMatch(/2 matching orders on a single page but 1/);
  });

  it.each([0, 1])(
    "calls an empty result with %p total pages a complete negative",
    (totalPages) => {
      const v = assessOrderPage([], {
        "total-items": 0,
        "total-pages": totalPages,
        "page-offset": 0,
        "per-page": 10,
        "current-item-count": 0,
      });
      expect(v.verdict).toBe("complete");
      expect(v.reason).toMatch(/complete negative/);
      expect(v.next_page_offset).toBeNull();
    },
  );

  it("calls an empty result past the first page complete when the total is zero", () => {
    const v = assessOrderPage([], {
      "total-items": 0,
      "total-pages": 0,
      "page-offset": 4,
    });
    expect(v.verdict).toBe("complete");
  });

  it("calls a full single page complete", () => {
    const v = assessOrderPage([{}, {}], {
      "total-items": 2,
      "total-pages": 1,
      "page-offset": 0,
      "per-page": 10,
    });
    expect(v).toEqual({
      verdict: "complete",
      reason: "This single page holds all 2 matching orders.",
      items_returned: 2,
      page_offset: 0,
      per_page: 10,
      total_items: 2,
      total_pages: 1,
      next_page_offset: null,
    });
  });

  it("calls the first of several pages partial and names the next", () => {
    const v = assessOrderPage([{}], {
      "total-items": 3,
      "total-pages": 3,
      "page-offset": 0,
      "per-page": 1,
    });
    expect(v.verdict).toBe("partial");
    expect(v.next_page_offset).toBe(1);
  });

  it("calls the last of several pages partial with no next page", () => {
    const v = assessOrderPage([{}], {
      "total-items": 3,
      "total-pages": 3,
      "page-offset": 2,
    });
    expect(v.verdict).toBe("partial");
    expect(v.per_page).toBeNull();
    expect(v.next_page_offset).toBeNull();
  });
});

describe("orderPageResult", () => {
  it("boxes the items, the broker's pagination and the verdict", () => {
    const pagination = { "total-items": 0, "total-pages": 0, "page-offset": 0 };
    expect(orderPageResult({ items: [], pagination })).toEqual({
      items: [],
      pagination,
      completeness: expect.objectContaining({ verdict: "complete" }),
    });
  });

  it("reports absent pagination as null", () => {
    expect(
      orderPageResult({ items: [], pagination: undefined }).pagination,
    ).toBeNull();
  });
});
