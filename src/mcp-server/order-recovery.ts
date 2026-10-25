/**
 * Order recovery: the caller's own order identifier, and whether an order read
 * was complete (tastytrade/tastytrade-mcp#47).
 *
 * A client that persists an order intent and then loses the submit outcome — a
 * timeout, a crash, a dropped connection after the token was spent — has to
 * answer one question before it may retry: "did my order reach the broker?".
 * Two things are needed for that answer to be trustworthy:
 *
 *   1. A handle the CALLER chose before submitting. tastytrade accepts a
 *      client-generated `external-identifier` on an order and echoes it on the
 *      resulting order. It is NOT an idempotency key — the broker does not
 *      deduplicate on it — but it lets the caller find its own order.
 *      `ext-client-order-id` is broker-assigned routing data and `source` is
 *      shared by every order this server places, so neither can stand in.
 *
 *   2. Proof that the read covered every matching order. A search that returns
 *      no match on page 0 of 3 proves nothing about pages 1 and 2, so an order
 *      read carries a server-authored `completeness` verdict computed from the
 *      broker's `pagination` object. Missing or malformed pagination is
 *      "unknown", never "complete".
 */

/** The longest `external_identifier` accepted. Generous for a UUID or ULID. */
export const MAX_EXTERNAL_IDENTIFIER_LENGTH = 255;

// Printable ASCII only. The value is sent unchanged and must round-trip through
// the broker byte-for-byte to be matchable, so anything a system on the way
// might normalise (whitespace runs, Unicode compositions, control characters)
// is refused rather than silently altered.
const EXTERNAL_IDENTIFIER_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

/**
 * Why an `external_identifier` argument is unacceptable, or `undefined` when it
 * is absent (the argument is optional) or valid.
 */
export function externalIdentifierProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return `\`external_identifier\` must be a string; received ${value === null ? "null" : typeof value}.`;
  }
  if (value.length === 0) {
    return "`external_identifier` must not be empty; omit it instead.";
  }
  if (value.length > MAX_EXTERNAL_IDENTIFIER_LENGTH) {
    return `\`external_identifier\` is ${value.length} characters; the limit is ${MAX_EXTERNAL_IDENTIFIER_LENGTH}.`;
  }
  if (!EXTERNAL_IDENTIFIER_PATTERN.test(value)) {
    return "`external_identifier` must be printable ASCII with no leading or trailing whitespace, so the broker echoes back exactly what was sent.";
  }
  return undefined;
}

/** The server's verdict on whether one order read saw every matching order. */
export interface OrderReadCompleteness {
  /**
   * `complete`: this single response holds every order matching the request.
   * `partial`: the pagination is coherent and other pages hold more orders.
   * `unknown`: nothing in the response proves completeness either way.
   */
  verdict: "complete" | "partial" | "unknown";
  reason: string;
  items_returned: number | null;
  page_offset: number | null;
  per_page: number | null;
  total_items: number | null;
  total_pages: number | null;
  /** The `page_offset` to request next, or null when there is no next page. */
  next_page_offset: number | null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function unknown(
  reason: string,
  itemsReturned: number | null,
): OrderReadCompleteness {
  return {
    verdict: "unknown",
    reason,
    items_returned: itemsReturned,
    page_offset: null,
    per_page: null,
    total_items: null,
    total_pages: null,
    next_page_offset: null,
  };
}

/**
 * Judge one order-list response against the broker's `pagination` object.
 *
 * Deliberately strict: every field it relies on must be present and a
 * non-negative integer, and the fields must agree with each other and with the
 * number of orders actually returned. Any doubt is `unknown`, because a
 * `complete` that was wrong is how an agent concludes "my order never reached
 * the broker" and submits it a second time.
 */
export function assessOrderPage(
  items: unknown,
  pagination: unknown,
): OrderReadCompleteness {
  if (!Array.isArray(items)) {
    return unknown(
      "The broker's answer was not an order array, so it cannot be judged complete.",
      null,
    );
  }
  const returned = items.length;
  if (pagination === undefined || pagination === null) {
    return unknown(
      "The broker sent no pagination metadata, so nothing proves this response holds every matching order.",
      returned,
    );
  }
  if (typeof pagination !== "object" || Array.isArray(pagination)) {
    return unknown(
      "The broker's pagination metadata is not an object, so it cannot be relied on.",
      returned,
    );
  }
  const p = pagination as Record<string, unknown>;
  const totalItems = nonNegativeInteger(p["total-items"]);
  const totalPages = nonNegativeInteger(p["total-pages"]);
  const pageOffset = nonNegativeInteger(p["page-offset"]);
  const missing = [
    totalItems === undefined && "total-items",
    totalPages === undefined && "total-pages",
    pageOffset === undefined && "page-offset",
  ].filter(Boolean);
  if (missing.length > 0) {
    return unknown(
      `The broker's pagination metadata lacks a usable ${missing.join(", ")}, so completeness cannot be established.`,
      returned,
    );
  }
  const perPageRaw = p["per-page"];
  const perPage = nonNegativeInteger(perPageRaw);
  if (perPageRaw !== undefined && (perPage === undefined || perPage === 0)) {
    return unknown(
      "The broker's pagination metadata has an unusable per-page.",
      returned,
    );
  }
  const currentRaw = p["current-item-count"];
  if (currentRaw !== undefined && currentRaw !== returned) {
    return unknown(
      `The broker says this page holds ${String(currentRaw)} orders but ${returned} arrived, so the page cannot be trusted.`,
      returned,
    );
  }

  const facts = {
    items_returned: returned,
    page_offset: pageOffset!,
    per_page: perPage ?? null,
    total_items: totalItems!,
    total_pages: totalPages!,
  };

  if (perPage !== undefined) {
    const expectedPages = Math.ceil(totalItems! / perPage);
    const pagesAgree =
      totalPages === expectedPages || (totalItems === 0 && totalPages === 1);
    if (!pagesAgree) {
      return unknown(
        `The broker's pagination is inconsistent: ${totalItems} orders at ${perPage} per page is ${expectedPages} pages, not ${totalPages}.`,
        returned,
      );
    }
  }

  if ((pageOffset === 0 && totalPages! <= 1) || totalItems === 0) {
    if (returned !== totalItems) {
      return unknown(
        `The broker reports ${totalItems} matching orders on a single page but ${returned} arrived.`,
        returned,
      );
    }
    return {
      verdict: "complete",
      reason:
        totalItems === 0
          ? "The broker reports no matching orders, and this single page is the whole result: a complete negative."
          : `This single page holds all ${totalItems} matching orders.`,
      ...facts,
      next_page_offset: null,
    };
  }

  const next = pageOffset! + 1 < totalPages! ? pageOffset! + 1 : null;
  return {
    verdict: "partial",
    reason:
      `This is page offset ${pageOffset} of ${totalPages} page(s) holding ${totalItems} matching orders. ` +
      "Read every page_offset from 0 to total_pages - 1 with the same filters before treating an order as absent.",
    ...facts,
    next_page_offset: next,
  };
}

/** An order-list tool result: the orders, the broker's paging, our verdict. */
export function orderPageResult(page: {
  items: unknown;
  pagination: unknown;
}): {
  items: unknown;
  pagination: unknown;
  completeness: OrderReadCompleteness;
} {
  return {
    items: page.items,
    pagination: page.pagination ?? null,
    completeness: assessOrderPage(page.items, page.pagination),
  };
}
