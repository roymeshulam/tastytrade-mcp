/**
 * Order recovery end to end (tastytrade/tastytrade-mcp#47): a caller-chosen
 * `external_identifier` bound into the confirmation token and echoed on reads,
 * and order-list reads that say whether they saw every matching order.
 *
 * Everything runs against the harness's fake transport; nothing reaches a broker.
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHarness, callError, callOk } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";

const ACCT = "5WX00001";
const EXT_ID = "intent-7f3c2a10-recovery";

const ORDER_ARGS = {
  account_number: ACCT,
  order_type: "Limit",
  time_in_force: "Day",
  price: "1.02",
  price_effect: "Debit",
  legs: [
    {
      symbol: "AAPL",
      instrument_type: "Equity",
      action: "Buy to Open",
      quantity: 1,
    },
  ],
};

const ORDER = {
  id: 1075999,
  "account-number": ACCT,
  "order-type": "Limit",
  "time-in-force": "Day",
  price: "1.02",
  "price-effect": "Debit",
  status: "Routed",
  "external-identifier": EXT_ID,
  "ext-client-order-id": "JAAAAAXQbUXvvcDx9E",
  source: "tastytrade-mcp/1.0.0",
  legs: [
    {
      "instrument-type": "Equity",
      symbol: "AAPL",
      action: "Buy to Open",
      quantity: 1,
      "remaining-quantity": 1,
      fills: [],
    },
  ],
};

const DRY_RUN_REPLY = {
  order: { ...ORDER, id: undefined, status: "Received" },
  warnings: [],
  "buying-power-effect": {
    "change-in-buying-power": "1.02",
    "change-in-buying-power-effect": "Debit",
    "current-buying-power": "1000000.0",
    "new-buying-power": "999998.98",
    "is-spread": false,
    impact: "1.02",
    effect: "Debit",
  },
  "fee-calculation": { "total-fees": "0.001", "total-fees-effect": "Debit" },
};

function sanityRoutes(): Route[] {
  return [
    {
      matcher: `/accounts/${ACCT}/position-limit`,
      method: "GET",
      reply: {
        data: {
          "account-number": ACCT,
          "equity-order-size": 100,
          "equity-option-order-size": 100,
          "future-order-size": 100,
          "underlying-opening-order-limit": 100,
        },
      },
    },
    {
      matcher: `/accounts/${ACCT}/trading-status`,
      method: "GET",
      reply: {
        data: {
          "account-number": ACCT,
          "is-frozen": false,
          "is-closing-only": false,
          "is-in-margin-call": false,
        },
      },
    },
  ];
}

const DRY_RUN_ROUTE: Route = {
  matcher: `/accounts/${ACCT}/orders/dry-run`,
  method: "POST",
  reply: { data: DRY_RUN_REPLY },
};

let h: Harness | undefined;

beforeEach(() => {
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

const posts = (harness: Harness, path: string) =>
  harness.requests.filter((r) => r.method === "POST" && r.url === path);

describe("external_identifier on dry_run_order / place_order", () => {
  it("sends the identical identifier in the dry-run and the live body, and keeps the echo", async () => {
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        DRY_RUN_ROUTE,
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: { data: { order: ORDER, warnings: [] } },
        },
      ],
    });
    const args = { ...ORDER_ARGS, external_identifier: EXT_ID };
    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string;
    };
    expect(typeof dry.confirmation_token).toBe("string");
    const placed = (await callOk(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: dry.confirmation_token,
    })) as { upstream: { order: Record<string, unknown> } };

    const [dryReq] = posts(h, `/accounts/${ACCT}/orders/dry-run`);
    const [liveReq] = posts(h, `/accounts/${ACCT}/orders`);
    expect((dryReq.body as any)["external-identifier"]).toBe(EXT_ID);
    expect((liveReq.body as any)["external-identifier"]).toBe(EXT_ID);
    expect(liveReq.body).toEqual(dryReq.body);
    // The broker's echo survives, and is not confused with its own ids.
    expect(placed.upstream.order["external-identifier"]).toBe(EXT_ID);
    expect(placed.upstream.order["ext-client-order-id"]).not.toBe(EXT_ID);
  });

  it("omits external-identifier from the body when none is given", async () => {
    h = await createHarness({ routes: [DRY_RUN_ROUTE] });
    await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS);
    expect(h.lastRequest()!.body as object).not.toHaveProperty(
      "external-identifier",
    );
  });

  it.each([
    ["a different identifier", { external_identifier: "someone-else" }],
    ["no identifier", { external_identifier: undefined }],
  ])(
    "refuses a token minted for one identifier when the submit carries %s",
    async (_label, override) => {
      h = await createHarness({
        routes: [
          ...sanityRoutes(),
          DRY_RUN_ROUTE,
          {
            matcher: `/accounts/${ACCT}/orders`,
            method: "POST",
            reply: { data: { order: ORDER } },
          },
        ],
      });
      const dry = (await callOk(h, "tastytrade_dry_run_order", {
        ...ORDER_ARGS,
        external_identifier: EXT_ID,
      })) as { confirmation_token: string };
      const err = await callError(h, "tastytrade_place_order", {
        ...ORDER_ARGS,
        ...override,
        confirmation_token: dry.confirmation_token,
      });
      expect(err.code).toBe("confirmation_expired");
      expect(posts(h, `/accounts/${ACCT}/orders`)).toHaveLength(0);
    },
  );

  it.each([
    ["empty", ""],
    ["padded", " abc"],
    ["control character", "abc\ndef"],
    ["non-ASCII", "ordre-é"],
    ["too long", "x".repeat(256)],
    ["a number", 42],
  ])(
    "refuses a %s identifier before any request leaves",
    async (_label, value) => {
      h = await createHarness({ routes: [DRY_RUN_ROUTE] });
      const err = await callError(h, "tastytrade_dry_run_order", {
        ...ORDER_ARGS,
        external_identifier: value,
      });
      expect(err.code).toBe("validation");
      expect(err.message).toContain("external_identifier");
      expect(h.requests).toHaveLength(0);
    },
  );

  it("refuses an invalid identifier on the submit too, without spending the token", async () => {
    h = await createHarness({ routes: [...sanityRoutes(), DRY_RUN_ROUTE] });
    const dry = (await callOk(h, "tastytrade_dry_run_order", {
      ...ORDER_ARGS,
      external_identifier: EXT_ID,
    })) as { confirmation_token: string };
    const err = await callError(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      external_identifier: "",
      confirmation_token: dry.confirmation_token,
    });
    expect(err.code).toBe("validation");
    expect(posts(h, `/accounts/${ACCT}/orders`)).toHaveLength(0);
  });

  it("does not resubmit after an uncertain submit outcome", async () => {
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        DRY_RUN_ROUTE,
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: { networkError: "ECONNRESET" },
        },
      ],
    });
    const args = { ...ORDER_ARGS, external_identifier: EXT_ID };
    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string;
    };
    await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: dry.confirmation_token,
    });
    // Exactly one live POST: the server never retries a submit itself.
    expect(posts(h, `/accounts/${ACCT}/orders`)).toHaveLength(1);
    // And the spent token cannot be replayed into a second order.
    const again = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: dry.confirmation_token,
    });
    expect(again.code).toBe("dry_run_required");
    expect(posts(h, `/accounts/${ACCT}/orders`)).toHaveLength(1);
  });

  it("keeps the echoed identifier on get_order", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/1075999`,
          method: "GET",
          reply: { data: ORDER },
        },
      ],
    });
    const order = (await callOk(h, "tastytrade_get_order", {
      account_number: ACCT,
      order_id: "1075999",
    })) as Record<string, unknown>;
    expect(order["external-identifier"]).toBe(EXT_ID);
  });
});

describe("order-list reads expose completeness", () => {
  interface ListResult {
    items: Array<Record<string, unknown>>;
    pagination: unknown;
    completeness: {
      verdict: string;
      next_page_offset: number | null;
      total_items: number | null;
    };
  }

  function listRoute(path: string, body: unknown): Route {
    return {
      matcher: path,
      method: "GET",
      reply: { data: body, raw: true },
    };
  }

  it("calls an empty single page a complete negative", async () => {
    h = await createHarness({
      routes: [
        listRoute(`/accounts/${ACCT}/orders`, {
          data: { items: [] },
          pagination: {
            "per-page": 10,
            "page-offset": 0,
            "item-offset": 0,
            "total-items": 0,
            "total-pages": 0,
            "current-item-count": 0,
          },
        }),
      ],
    });
    const res = (await callOk(h, "tastytrade_search_orders", {
      account_number: ACCT,
    })) as ListResult;
    expect(res.items).toEqual([]);
    expect(res.completeness.verdict).toBe("complete");
  });

  it("finds the echoed identifier on a complete single page", async () => {
    h = await createHarness({
      routes: [
        listRoute(`/accounts/${ACCT}/orders`, {
          data: { items: [ORDER] },
          pagination: {
            "per-page": 10,
            "page-offset": 0,
            "total-items": 1,
            "total-pages": 1,
            "current-item-count": 1,
          },
        }),
      ],
    });
    const res = (await callOk(h, "tastytrade_search_orders", {
      account_number: ACCT,
    })) as ListResult;
    expect(res.completeness.verdict).toBe("complete");
    expect(res.items[0]["external-identifier"]).toBe(EXT_ID);
  });

  it("calls page 0 of 3 partial and names the next page", async () => {
    h = await createHarness({
      routes: [
        listRoute(`/accounts/${ACCT}/orders`, {
          data: { items: [ORDER] },
          pagination: {
            "per-page": 1,
            "page-offset": 0,
            "total-items": 3,
            "total-pages": 3,
            "current-item-count": 1,
          },
        }),
      ],
    });
    const res = (await callOk(h, "tastytrade_search_orders", {
      account_number: ACCT,
      per_page: 1,
    })) as ListResult;
    expect(res.completeness.verdict).toBe("partial");
    expect(res.completeness.next_page_offset).toBe(1);
    expect(res.completeness.total_items).toBe(3);
    expect(res.pagination).toMatchObject({ "total-pages": 3 });
  });

  it("never calls a response with malformed pagination complete", async () => {
    h = await createHarness({
      routes: [
        listRoute("/customers/me/orders", {
          data: { items: [] },
          pagination: { "total-items": "0", "total-pages": 0 },
        }),
      ],
    });
    const res = (await callOk(h, "tastytrade_search_customer_orders", {
      account_numbers: [ACCT],
    })) as ListResult;
    expect(res.completeness.verdict).toBe("unknown");
  });

  it("judges today's orders the same way", async () => {
    h = await createHarness({
      routes: [
        listRoute(`/accounts/${ACCT}/orders/live`, {
          data: { items: [ORDER] },
          pagination: {
            "page-offset": 0,
            "total-items": 1,
            "total-pages": 1,
          },
        }),
        listRoute("/customers/me/orders/live", { data: { items: [ORDER] } }),
      ],
    });
    const account = (await callOk(h, "tastytrade_get_live_orders", {
      account_number: ACCT,
    })) as ListResult;
    expect(account.completeness.verdict).toBe("complete");
    const customer = (await callOk(h, "tastytrade_get_customer_live_orders", {
      account_numbers: [ACCT],
    })) as ListResult;
    // No pagination at all: not provably complete.
    expect(customer.completeness.verdict).toBe("unknown");
    expect(customer.pagination).toBeNull();
  });
});
