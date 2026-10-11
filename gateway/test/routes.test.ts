// HTTP-level tests for the routes the gateway serves today. They exist before
// the checkout page is refactored, so the refactor has something to answer to.
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), end: async () => {} },
}));

import { createApp } from "../src/app.js";

const INVOICE_ID = "0c0766e8-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const SUBADDRESS = "8" + "A1b2C3d4E5".repeat(9) + "A1b2";

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    merchant_id: "1cf6b8b8-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    amount_atomic: "44186005408",
    price_amount: "25.00",
    price_currency: "USD",
    rate: 565.8,
    description: "Order 1042",
    subaddress: SUBADDRESS,
    status: "pending",
    expires_at: "2026-09-22T11:54:03.184Z",
    created_at: "2026-09-22T10:54:03.184Z",
    return_url: null,
    metadata: { order_id: 1042 },
    received_atomic: "0",
    confirmations: 0,
    ...over,
  };
}

const app = () => createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });

beforeEach(() => {
  query.mockReset();
});

describe("createApp", () => {
  it("refuses a network it cannot validate addresses for", () => {
    expect(() => createApp({ baseUrl: "https://pay.example.com", network: "regtest" })).toThrow(/MONERO_NETWORK/);
  });
});

describe("GET /healthz", () => {
  it("reports ok when the database answers", async () => {
    query.mockResolvedValue({ rows: [{ "?column?": 1 }], rowCount: 1 });
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", network: "stagenet", checks: { database: "ok" } });
  });

  it("reports degraded with 503 when the database does not", async () => {
    query.mockRejectedValue(new Error("connection refused"));
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.checks.database).toContain("connection refused");
  });
});

describe("security headers", () => {
  // The invoice id is a capability, so it must not travel in a Referer when
  // the buyer clicks through to the merchant's return_url.
  it("sends no-referrer and nosniff on HTML", async () => {
    query.mockResolvedValue({ rows: [invoiceRow()], rowCount: 1 });
    const res = await request(app()).get(`/checkout/${INVOICE_ID}`);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends them on JSON too", async () => {
    query.mockResolvedValue({ rows: [invoiceRow()], rowCount: 1 });
    const res = await request(app()).get(`/api/invoices/${INVOICE_ID}`);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });
});

describe("GET /api/invoices/:id", () => {
  it("returns the public invoice view", async () => {
    query.mockResolvedValue({ rows: [invoiceRow({ received_atomic: "44186005408", confirmations: 3 })], rowCount: 1 });
    const res = await request(app()).get(`/api/invoices/${INVOICE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: INVOICE_ID,
      status: "pending",
      amount_due_atomic: "44186005408",
      amount_due_xmr: "0.044186005408",
      amount_received_xmr: "0.044186005408",
      confirmations: 3,
      metadata: { order_id: 1042 },
    });
  });

  it("404s a malformed id without touching the database", async () => {
    const res = await request(app()).get("/api/invoices/not-a-uuid");
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("404s an unknown id", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app()).get(`/api/invoices/${INVOICE_ID}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /checkout/:id", () => {
  it("renders the address, the wallet URI, a QR and the status", async () => {
    query.mockResolvedValue({ rows: [invoiceRow()], rowCount: 1 });
    const res = await request(app()).get(`/checkout/${INVOICE_ID}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(SUBADDRESS);
    expect(res.text).toContain(`monero:${SUBADDRESS}?tx_amount=0.044186005408`);
    expect(res.text).toContain("<img src=\"data:image/png;base64,");
    expect(res.text).toContain('class="status pending"');
    expect(res.text).toContain("Pay 0.044186005408 XMR");
    expect(res.text).toContain("25.00 USD @ 565.80 USD/XMR");
  });

  it("omits the return link when the invoice has no return_url", async () => {
    query.mockResolvedValue({ rows: [invoiceRow()], rowCount: 1 });
    const res = await request(app()).get(`/checkout/${INVOICE_ID}`);
    expect(res.text).not.toContain("Return to your order");
  });

  it("shows the return link when it has one", async () => {
    query.mockResolvedValue({ rows: [invoiceRow({ return_url: "https://shop.example.com/orders/1042" })], rowCount: 1 });
    const res = await request(app()).get(`/checkout/${INVOICE_ID}`);
    expect(res.text).toContain('<a href="https://shop.example.com/orders/1042">Return to your order</a>');
  });

  it("escapes a merchant-supplied description", async () => {
    query.mockResolvedValue({ rows: [invoiceRow({ description: "<script>alert(1)</script>" })], rowCount: 1 });
    const res = await request(app()).get(`/checkout/${INVOICE_ID}`);
    expect(res.text).not.toContain("<script>alert(1)");
    expect(res.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("404s a malformed id with a plain-text body", async () => {
    const res = await request(app()).get("/checkout/not-a-uuid");
    expect(res.status).toBe(404);
    expect(res.text).toBe("Invoice not found");
  });
});

describe("authentication", () => {
  it("401s a merchant route with no Bearer key", async () => {
    const res = await request(app()).get("/api/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing Bearer API key/);
  });

  it("401s an unknown key", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app()).get("/api/me").set("Authorization", "Bearer xmr_sk_nope");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid API key/);
  });

  it("serves a merchant route once the key matches", async () => {
    query.mockResolvedValue({
      rows: [
        {
          id: "1cf6b8b8-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
          name: "Test Shop",
          address: "5" + "A1b2C3d4E5".repeat(9) + "A1b2",
          wallet_name: "m_1",
          webhook_url: "https://shop.example.com/hook",
          webhook_secret: "s3cret",
          created_at: "2026-09-22T10:00:00.000Z",
        },
      ],
      rowCount: 1,
    });
    const res = await request(app()).get("/api/me").set("Authorization", "Bearer xmr_sk_good");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Test Shop");
    // Nothing secret leaves through this route.
    expect(JSON.stringify(res.body)).not.toContain("s3cret");
    expect(JSON.stringify(res.body)).not.toContain("m_1");
  });
});

describe("POST /api/merchants", () => {
  // Signup writes a wallet file and holds the wallet lock for minutes, so it
  // stays shut unless the operator deliberately opens it.
  it("is closed when SIGNUP_TOKEN is unset", async () => {
    const res = await request(app()).post("/api/merchants").send({ name: "Shop" });
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
