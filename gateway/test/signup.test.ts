// Signup, with the token gate held open. It lives in its own file because
// security.ts reads SIGNUP_TOKEN once at import, so the gate cannot be opened
// and closed within one module registry.
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), connect: async () => ({ query: async () => {}, release: () => {} }), end: async () => {} },
}));

const walletRpc = vi.fn();
const daemonRpc = vi.fn();
const createViewOnlyWallet = vi.fn();
vi.mock("../src/walletRpc.js", () => ({
  walletRpc: (...a: unknown[]) => walletRpc(...a),
  daemonRpc: (...a: unknown[]) => daemonRpc(...a),
  createViewOnlyWallet: (...a: unknown[]) => createViewOnlyWallet(...a),
  walletRpcVersion: async () => 1,
  withWallet: async (_n: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../src/security.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/security.js")>();
  return {
    ...real,
    // The gate itself is covered in routes.test.ts and security.test.ts.
    requireSignupToken: (_req: unknown, _res: unknown, next: () => void) => next(),
    // Real DNS resolution would make this suite depend on the network.
    assertSafeWebhookUrl: async () => {},
  };
});

import { createApp } from "../src/app.js";

const STAGENET_ADDRESS = "5" + "A1b2C3d4E5".repeat(9) + "A1b2";
const VIEW_KEY = "a".repeat(64);
const app = () => createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });

function insertReturns() {
  // 1st query: the duplicate-address check. 2nd: the INSERT.
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  query.mockResolvedValueOnce({
    rows: [{ id: "1cf6b8b8-1a2b-4c3d-8e4f-5a6b7c8d9e0f", created_at: "2026-10-11T22:00:00.000Z" }],
    rowCount: 1,
  });
}

beforeEach(() => {
  query.mockReset();
  walletRpc.mockReset();
  daemonRpc.mockReset();
  createViewOnlyWallet.mockReset();
});

describe("POST /api/merchants", () => {
  it("returns the credentials without waiting for the wallet", async () => {
    insertReturns();
    const res = await request(app())
      .post("/api/merchants")
      .send({ name: "Test Shop", address: STAGENET_ADDRESS, view_key: VIEW_KEY, webhook_url: "https://shop.example.com/hook" });

    expect(res.status).toBe(201);
    expect(res.body.api_key).toMatch(/^xmr_sk_[0-9a-f]{64}$/);
    expect(res.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.wallet_status).toBe("provisioning");

    // The point of the whole change: no wallet work happens in the request,
    // because generate_from_keys outlives a reverse proxy's read timeout and
    // the response carries the only copy of the API key.
    expect(createViewOnlyWallet).not.toHaveBeenCalled();
    expect(walletRpc).not.toHaveBeenCalled();
    expect(daemonRpc).not.toHaveBeenCalled();

    const insert = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO merchants"));
    expect(insert).toBeTruthy();
    // Only a hash of the key is stored.
    expect(String(insert![1])).not.toContain(res.body.api_key);
  });

  it("accepts an account with no webhook URL", async () => {
    insertReturns();
    const res = await request(app())
      .post("/api/merchants")
      .send({ name: "Checkout only", address: STAGENET_ADDRESS, view_key: VIEW_KEY });
    expect(res.status).toBe(201);
    const insert = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO merchants"));
    expect((insert![1] as unknown[])[5]).toBeNull();
  });

  it("refuses an address from another network", async () => {
    const res = await request(app())
      .post("/api/merchants")
      .send({ name: "Shop", address: "4" + "A1b2C3d4E5".repeat(9) + "A1b2", view_key: VIEW_KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("stagenet");
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a view key that is not 64 hex", async () => {
    const res = await request(app())
      .post("/api/merchants")
      .send({ name: "Shop", address: STAGENET_ADDRESS, view_key: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/view_key/);
  });

  it("refuses a second account on the same address", async () => {
    // Two accounts on one address would derive identical invoice subaddresses
    // and cross-attribute each other's payments.
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });
    const res = await request(app())
      .post("/api/merchants")
      .send({ name: "Shop", address: STAGENET_ADDRESS, view_key: VIEW_KEY });
    expect(res.status).toBe(409);
  });
});
