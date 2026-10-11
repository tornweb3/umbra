import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), end: async () => {} },
}));

const walletRpcVersion = vi.fn();
const daemonRpc = vi.fn();
vi.mock("../src/walletRpc.js", () => ({
  walletRpcVersion: () => walletRpcVersion(),
  daemonRpc: (...a: unknown[]) => daemonRpc(...a),
  walletRpc: async () => ({}),
  withWallet: async (_n: string, fn: () => Promise<unknown>) => fn(),
  createViewOnlyWallet: async () => {},
}));

import { createApp } from "../src/app.js";
import { clearStatusCache, workerLooksStopped } from "../src/portal/status.js";
import { COOKIE_NAME } from "../src/portal/session.js";

const app = () => createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });
const TOKEN = "z".repeat(43);
const withSession = (r: request.Test) => r.set("Cookie", `${COOKIE_NAME}=${TOKEN}`);

function db(opts: { lastPassMsAgo?: number | null; workerError?: string | null; failedWallets?: number; provisioning?: number } = {}) {
  query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("count(*)") && text.includes("portal_users")) return { rows: [{ n: "1" }], rowCount: 1 };
    if (text.includes("FROM portal_sessions s")) {
      return {
        rows: [
          {
            id: "s1", csrf: "c", reauth_at: null, last_seen_at: new Date().toISOString(),
            user_id: "u1", username: "owner", merchant_id: "m1", name: "Shop",
            address: "5addr", wallet_name: "w", webhook_url: null,
            wallet_ready_at: opts.provisioning ? null : "2026-10-11T22:00:00.000Z", wallet_error: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM worker_heartbeat")) {
      const ms = opts.lastPassMsAgo;
      if (ms === null || ms === undefined) return { rows: [], rowCount: 0 };
      return {
        rows: [{ last_pass_at: new Date(Date.now() - ms).toISOString(), pass_ms: 42, last_error: opts.workerError ?? null }],
        rowCount: 1,
      };
    }
    if (text.includes("AS pending")) {
      return {
        rows: [{ pending: "3", detected: "1", undelivered: "2", provisioning: String(opts.provisioning ?? 0), failed_wallets: String(opts.failedWallets ?? 0) }],
        rowCount: 1,
      };
    }
    if (text.includes("FROM schema_migrations")) {
      return {
        rows: [
          { filename: "001_initial.sql", applied_at: "2026-10-11T20:00:00.000Z" },
          { filename: "002_portal.sql", applied_at: "2026-10-11T21:00:00.000Z" },
        ],
        rowCount: 2,
      };
    }
    if (text.includes("GROUP BY status")) return { rows: [], rowCount: 0 };
    if (text.includes("FROM payments p JOIN invoices i")) return { rows: [{ total: "0" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  query.mockReset();
  walletRpcVersion.mockReset();
  daemonRpc.mockReset();
  clearStatusCache();
  walletRpcVersion.mockResolvedValue(65558);
  daemonRpc.mockResolvedValue({ height: 3_200_000, synchronized: true, target_height: 0 });
});

describe("workerLooksStopped", () => {
  it("treats no heartbeat at all as stopped", () => {
    expect(workerLooksStopped(null)).toBe(true);
  });

  it("allows a few missed polls before crying wolf", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(workerLooksStopped(ago(1000), 15000)).toBe(false);
    expect(workerLooksStopped(ago(59_000), 15000)).toBe(false);
    expect(workerLooksStopped(ago(61_000), 15000)).toBe(true);
    // A long poll interval gets proportionally more slack, with a floor so a
    // tiny interval does not make this alarm on every blip.
    expect(workerLooksStopped(ago(61_000), 60_000)).toBe(false);
    expect(workerLooksStopped(ago(241_000), 60_000)).toBe(true);
  });
});

describe("the status page", () => {
  it("shows each service, the queues and the version", async () => {
    db({ lastPassMsAgo: 2000 });
    const res = await withSession(request(app()).get("/portal/status"));
    expect(res.status).toBe(200);
    expect(res.text).toContain("version 65558");
    expect(res.text).toContain("synced, height 3200000");
    expect(res.text).toContain("last pass 2s ago");
    expect(res.text).toContain('class="dot up"');
    expect(res.text).toContain("Invoices awaiting payment");
    expect(res.text).toContain("stagenet");
    expect(res.text).toContain("002_portal.sql");
    expect(res.text).not.toContain('class="dot down"');
  });

  it("says plainly when the worker is not running, and how to start it", async () => {
    db({ lastPassMsAgo: null });
    const res = await withSession(request(app()).get("/portal/status"));
    expect(res.text).toContain("has not completed a pass");
    expect(res.text).toContain("npm run start:worker");
    expect(res.text).toContain('class="dot down"');
  });

  it("surfaces the worker's own last error", async () => {
    db({ lastPassMsAgo: 2000, workerError: "wallet-rpc refused the connection" });
    const res = await withSession(request(app()).get("/portal/status"));
    expect(res.text).toContain("wallet-rpc refused the connection");
  });

  it("counts a syncing node as not ready", async () => {
    // Payments in blocks it has not seen cannot be detected, so this is not a
    // green light even though the call succeeded.
    daemonRpc.mockResolvedValue({ height: 1_000_000, synchronized: false, target_height: 3_200_000 });
    db({ lastPassMsAgo: 2000 });
    const res = await withSession(request(app()).get("/portal/status"));
    expect(res.text).toContain("syncing, height 1000000 of 3200000");
    expect(res.text).toContain('class="dot down"');
  });

  it("reports an unreachable service instead of failing the page", async () => {
    walletRpcVersion.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:18083"));
    db({ lastPassMsAgo: 2000 });
    const res = await withSession(request(app()).get("/portal/status"));
    expect(res.status).toBe(200);
    expect(res.text).toContain("ECONNREFUSED");
  });

  it("warns about accounts whose wallet could not be prepared", async () => {
    db({ lastPassMsAgo: 2000, failedWallets: 2, provisioning: 2 });
    const res = await withSession(request(app()).get("/portal/status"));
    expect(res.text).toContain("2 accounts");
    expect(res.text).toContain("could not have a wallet prepared");
  });

  it("caches the probes so a reload does not hammer the node", async () => {
    db({ lastPassMsAgo: 2000 });
    const a = app();
    await withSession(request(a).get("/portal/status"));
    await withSession(request(a).get("/portal/status"));
    await withSession(request(a).get("/portal/status"));
    expect(walletRpcVersion).toHaveBeenCalledTimes(1);
    expect(daemonRpc).toHaveBeenCalledTimes(1);
  });

  it("needs a session like every other console page", async () => {
    db({ lastPassMsAgo: 2000 });
    const res = await request(app()).get("/portal/status");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/portal/login");
  });
});

describe("the overview banner", () => {
  it("blames the stopped worker when a wallet is stuck preparing", async () => {
    db({ lastPassMsAgo: null, provisioning: 1 });
    const res = await withSession(request(app()).get("/portal"));
    expect(res.text).toContain("cannot be prepared because the worker is not");
    expect(res.text).toContain("/portal/status");
  });

  it("just says preparing while the worker is alive", async () => {
    db({ lastPassMsAgo: 2000, provisioning: 1 });
    const res = await withSession(request(app()).get("/portal"));
    expect(res.text).toContain("being prepared");
    expect(res.text).not.toContain("worker is not");
  });
});
