import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), end: async () => {} },
}));

const walletRpc = vi.fn();
vi.mock("../src/walletRpc.js", () => ({
  walletRpc: (...a: unknown[]) => walletRpc(...a),
  withWallet: async (_n: string, fn: () => Promise<unknown>) => fn(),
  daemonRpc: async () => ({ height: 1_000_000 }),
  createViewOnlyWallet: async () => {},
  walletRpcVersion: async () => 1,
}));

import { createApp } from "../src/app.js";
import { COOKIE_NAME } from "../src/portal/session.js";

const app = () => createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });
const MERCHANT = "1cf6b8b8-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const INVOICE = "0c0766e8-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const DELIVERY = "7f0766e8-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const TOKEN = "t".repeat(43);
const withSession = (r: request.Test) => r.set("Cookie", `${COOKIE_NAME}=${TOKEN}`);

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    merchant_id: MERCHANT,
    amount_atomic: "44186005408",
    price_amount: "25.00",
    price_currency: "USD",
    rate: 565.8,
    description: "Order 1042",
    subaddress: "8" + "A1b2C3d4E5".repeat(9) + "A1b2",
    status: "pending",
    expires_at: "2026-09-22T11:54:03.184Z",
    created_at: "2026-09-22T10:54:03.184Z",
    return_url: null,
    metadata: null,
    received_atomic: "0",
    confirmations: 0,
    ...over,
  };
}

/** `invoices` is the list the mocked SELECT returns; the rest is boilerplate. */
function db(opts: { invoices?: any[]; payments?: any[]; deliveries?: any[]; walletReady?: boolean } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes("count(*)") && text.includes("portal_users")) return { rows: [{ n: "1" }], rowCount: 1 };
    if (text.includes("FROM portal_sessions s")) {
      return {
        rows: [
          {
            id: "s1",
            csrf: "csrf-token-value",
            reauth_at: null,
            last_seen_at: new Date().toISOString(),
            user_id: "u1",
            username: "owner",
            merchant_id: MERCHANT,
            name: "Test Shop",
            address: "5" + "A1b2C3d4E5".repeat(9) + "A1b2",
            wallet_name: "m_1",
            webhook_url: "https://shop.example.com/hook",
            wallet_ready_at: opts.walletReady === false ? null : "2026-10-11T22:00:00.000Z",
            wallet_error: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM invoices i LEFT JOIN payments")) return { rows: opts.invoices ?? [], rowCount: 0 };
    if (text.includes("FROM payments WHERE invoice_id")) return { rows: opts.payments ?? [], rowCount: 0 };
    if (text.includes("FROM webhook_deliveries WHERE invoice_id")) return { rows: opts.deliveries ?? [], rowCount: 0 };
    if (text.includes("UPDATE webhook_deliveries")) return { rows: [{ id: DELIVERY }], rowCount: 1 };
    if (text.includes("INSERT INTO invoices")) {
      return { rows: [{ id: INVOICE, status: "pending", expires_at: "2026-09-22T11:54:03.184Z" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

beforeEach(() => {
  query.mockReset();
  walletRpc.mockReset();
});

describe("the invoice list", () => {
  it("says so when there is nothing yet", async () => {
    db({ invoices: [] });
    const res = await withSession(request(app()).get("/portal/invoices"));
    expect(res.status).toBe(200);
    expect(res.text).toContain("No invoices");
    expect(res.text).toContain("/portal/invoices/new");
  });

  it("lists invoices with their status and amounts", async () => {
    db({ invoices: [invoiceRow(), invoiceRow({ id: DELIVERY, status: "confirmed", received_atomic: "44186005408" })] });
    const res = await withSession(request(app()).get("/portal/invoices"));
    expect(res.text).toContain("0.044186005408");
    expect(res.text).toContain("25.00 USD");
    expect(res.text).toContain('class="status pending"');
    expect(res.text).toContain('class="status confirmed"');
    expect(res.text).toContain(`/portal/invoices/${INVOICE}`);
  });

  it("scopes the query to the session's own merchant", async () => {
    const calls = db({ invoices: [] });
    await withSession(request(app()).get("/portal/invoices"));
    const list = calls.find((c) => c.sql.includes("FROM invoices i LEFT JOIN payments"));
    expect(list!.params[0]).toBe(MERCHANT);
  });

  it("offers an older page only when there is one", async () => {
    // The query asks for one more row than it shows; that extra row is how it
    // knows, without counting the whole table.
    db({ invoices: Array.from({ length: 26 }, (_, i) => invoiceRow({ id: `0c0766e8-1a2b-4c3d-8e4f-5a6b7c8d9e${String(i).padStart(2, "0")}` })) });
    const res = await withSession(request(app()).get("/portal/invoices"));
    expect(res.text).toContain("Older");
    expect(res.text).toContain("before=0c0766e8-1a2b-4c3d-8e4f-5a6b7c8d9e24");

    db({ invoices: [invoiceRow()] });
    const short = await withSession(request(app()).get("/portal/invoices"));
    expect(short.text).not.toContain("Older");
  });

  it("ignores a status that is not one of the four", async () => {
    const calls = db({ invoices: [] });
    await withSession(request(app()).get("/portal/invoices?status=' OR 1=1--"));
    const list = calls.find((c) => c.sql.includes("FROM invoices i LEFT JOIN payments"));
    expect(list!.sql).not.toContain("i.status =");
  });

  it("passes a search through as a parameter, never as SQL", async () => {
    const calls = db({ invoices: [] });
    await withSession(request(app()).get("/portal/invoices?q=%27%3B%20DROP%20TABLE%20invoices%3B%20--"));
    const list = calls.find((c) => c.sql.includes("FROM invoices i LEFT JOIN payments"));
    expect(list!.sql).toContain("ILIKE $");
    expect(list!.sql).not.toContain("DROP TABLE");
    expect(list!.params).toContain("%'; DROP TABLE invoices; --%");
  });

  it("escapes a description on the list", async () => {
    db({ invoices: [invoiceRow({ description: '<script>alert(1)</script>' })] });
    const res = await withSession(request(app()).get("/portal/invoices"));
    expect(res.text).not.toContain("<script>alert(1)");
    expect(res.text).toContain("&lt;script&gt;");
  });
});

describe("the invoice detail page", () => {
  it("shows the amounts, the subaddress and the checkout link", async () => {
    db({ invoices: [invoiceRow()] });
    const res = await withSession(request(app()).get(`/portal/invoices/${INVOICE}`));
    expect(res.status).toBe(200);
    expect(res.text).toContain("8A1b2C3d4E5");
    expect(res.text).toContain(`https://pay.example.com/checkout/${INVOICE}`);
    expect(res.text).toContain("565.8 USD/XMR");
  });

  it("shows payments and the delivery log with a redeliver button", async () => {
    db({
      invoices: [invoiceRow({ status: "confirmed", received_atomic: "44186005408", confirmations: 12 })],
      payments: [
        { txid: "5faf1d15", amount_atomic: "44186005408", confirmations: 12, detected_at: "2026-09-22T11:00:00.000Z", confirmed_at: "2026-09-22T11:20:00.000Z" },
      ],
      deliveries: [
        { id: DELIVERY, event: "payment_confirmed", attempts: 2, next_attempt_at: null, delivered_at: null, last_error: "HTTP 502", created_at: "2026-09-22T11:20:00.000Z" },
      ],
    });
    const res = await withSession(request(app()).get(`/portal/invoices/${INVOICE}`));
    expect(res.text).toContain("5faf1d15");
    // Formatted from the integer, not through a float.
    expect(res.text).toContain("0.044186005408");
    expect(res.text).toContain("payment_confirmed");
    expect(res.text).toContain("HTTP 502");
    expect(res.text).toContain("Redeliver");
    expect(res.text).toContain(`/portal/invoices/${INVOICE}/redeliver`);
  });

  it("404s a malformed id without a query", async () => {
    db();
    const res = await withSession(request(app()).get("/portal/invoices/not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("404s another merchant's invoice", async () => {
    const calls = db({ invoices: [] });
    const res = await withSession(request(app()).get(`/portal/invoices/${DELIVERY}`));
    expect(res.status).toBe(404);
    const select = calls.find((c) => c.sql.includes("i.merchant_id = $2"));
    expect(select!.params[1]).toBe(MERCHANT);
  });
});

describe("creating an invoice from the console", () => {
  const post = (body: Record<string, string>) =>
    withSession(request(app()).post("/portal/invoices")).send({ _csrf: "csrf-token-value", ...body });

  it("refuses both an XMR amount and a fiat price", async () => {
    db();
    const res = await post({ amount_xmr: "1.0", price_amount: "25", price_currency: "USD" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("not both");
  });

  it("refuses neither", async () => {
    db();
    const res = await post({ description: "nothing priced" });
    expect(res.status).toBe(400);
  });

  it("mints and redirects to the new invoice", async () => {
    db();
    walletRpc.mockImplementation(async (method: string) =>
      method === "create_address" ? { address: "8sub", address_index: 4 } : {}
    );
    const res = await post({ amount_xmr: "0.5", description: "A thing" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/portal/invoices/${INVOICE}`);
  });

  it("refuses while the wallet is still being provisioned", async () => {
    db({ walletReady: false });
    const res = await post({ amount_xmr: "0.5" });
    expect(res.status).toBe(503);
    expect(res.text).toContain("still being prepared");
    expect(walletRpc).not.toHaveBeenCalled();
  });

  it("refuses without the CSRF token", async () => {
    db();
    const res = await withSession(request(app()).post("/portal/invoices")).send({ amount_xmr: "0.5" });
    expect(res.status).toBe(403);
    expect(walletRpc).not.toHaveBeenCalled();
  });
});

describe("redelivering a webhook", () => {
  it("requeues one and comes back to the invoice", async () => {
    const calls = db();
    const res = await withSession(request(app()).post(`/portal/invoices/${INVOICE}/redeliver`)).send({
      _csrf: "csrf-token-value",
      delivery_id: DELIVERY,
    });
    expect(res.status).toBe(303);
    const update = calls.find((c) => c.sql.includes("UPDATE webhook_deliveries"));
    // Scoped to this merchant's invoice: a delivery id is not authority.
    expect(update!.params).toEqual([DELIVERY, INVOICE, MERCHANT]);
  });

  it("404s a malformed delivery id", async () => {
    db();
    const res = await withSession(request(app()).post(`/portal/invoices/${INVOICE}/redeliver`)).send({
      _csrf: "csrf-token-value",
      delivery_id: "nope",
    });
    expect(res.status).toBe(404);
  });
});
