import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), end: async () => {} },
}));

import { createApp } from "../src/app.js";
import { COOKIE_NAME, hashPassword } from "../src/portal/session.js";

const app = () => createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });
const MERCHANT = "1cf6b8b8-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const TOKEN = "s".repeat(43);
const CSRF = "csrf-token-value";
const PASSWORD = "the console password";
let passwordHash = "";

const withSession = (r: request.Test) => r.set("Cookie", `${COOKIE_NAME}=${TOKEN}`);

interface DbOpts {
  reauthAgeMs?: number | null;
  hasPrevious?: boolean;
  prevUsed?: boolean;
  sessions?: number;
  webhookUrl?: string | null;
}

function db(opts: DbOpts = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes("count(*)") && text.includes("portal_users")) return { rows: [{ n: "1" }], rowCount: 1 };
    if (text.includes("FROM portal_sessions s")) {
      const age = opts.reauthAgeMs;
      return {
        rows: [
          {
            id: "s1",
            csrf: CSRF,
            reauth_at: age === null || age === undefined ? null : new Date(Date.now() - age).toISOString(),
            last_seen_at: new Date().toISOString(),
            user_id: "u1",
            username: "owner",
            merchant_id: MERCHANT,
            name: "Test Shop",
            address: "5" + "A1b2C3d4E5".repeat(9) + "A1b2",
            wallet_name: "m_1",
            webhook_url: opts.webhookUrl ?? null,
            wallet_ready_at: "2026-10-11T22:00:00.000Z",
            wallet_error: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("api_key_created_at")) {
      return {
        rows: [
          {
            api_key_created_at: "2026-10-01T10:00:00.000Z",
            prev_api_key_expires_at: opts.hasPrevious ? new Date(Date.now() + 3_600_000).toISOString() : null,
            prev_api_key_last_used_at: opts.prevUsed ? new Date(Date.now() - 40_000).toISOString() : null,
            has_previous: Boolean(opts.hasPrevious),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM portal_sessions WHERE user_id")) {
      const n = opts.sessions ?? 1;
      return {
        rows: Array.from({ length: n }, (_, i) => ({
          id: i === 0 ? "s1" : `s${i + 1}`,
          user_agent: "vitest",
          last_seen_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          current: i === 0,
        })),
        rowCount: n,
      };
    }
    if (text.includes("SELECT password_hash FROM portal_users")) {
      return { rows: [{ password_hash: passwordHash }], rowCount: 1 };
    }
    if (text.includes("UPDATE merchants")) return { rows: [{ prev_api_key_expires_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return calls;
}

beforeEach(async () => {
  query.mockReset();
  if (!passwordHash) passwordHash = await hashPassword(PASSWORD);
});

describe("the settings page", () => {
  it("asks for the password again before showing any dangerous form", async () => {
    db({ reauthAgeMs: null });
    const res = await withSession(request(app()).get("/portal/settings"));
    expect(res.status).toBe(200);
    expect(res.text).toContain("Confirm your password");
    // No webhook field, no rotate buttons until the password is re-entered.
    expect(res.text).not.toContain('name="webhook_url"');
    expect(res.text).not.toContain("Rotate API key");
    expect(res.text).not.toContain("Rotate webhook secret");
  });

  it("shows the forms once the password was confirmed recently", async () => {
    db({ reauthAgeMs: 60_000, webhookUrl: "https://8.8.8.8/hook" });
    const res = await withSession(request(app()).get("/portal/settings"));
    expect(res.text).toContain('name="webhook_url"');
    expect(res.text).toContain("Rotate API key");
    expect(res.text).toContain("https://8.8.8.8/hook");
    expect(res.text).not.toContain("Confirm your password");
  });

  it("asks again once the window has passed", async () => {
    db({ reauthAgeMs: 11 * 60_000 });
    const res = await withSession(request(app()).get("/portal/settings"));
    expect(res.text).toContain("Confirm your password");
  });

  it("reports whether anything is still using the previous key", async () => {
    db({ reauthAgeMs: 60_000, hasPrevious: true, prevUsed: true });
    const used = await withSession(request(app()).get("/portal/settings"));
    expect(used.text).toContain("Something is still using the old key");
    expect(used.text).toContain("Revoke the previous key now");

    db({ reauthAgeMs: 60_000, hasPrevious: true, prevUsed: false });
    const unused = await withSession(request(app()).get("/portal/settings"));
    expect(unused.text).toContain("Safe to revoke");
  });
});

describe("the re-auth gate", () => {
  const post = (path: string, body: Record<string, string> = {}) =>
    withSession(request(app()).post(path)).send({ _csrf: CSRF, ...body });

  it("refuses every credential change without a recent password", async () => {
    for (const [path, body] of [
      ["/portal/settings/webhook", { webhook_url: "https://evil.example/collect" }],
      ["/portal/settings/rotate-webhook-secret", {}],
      ["/portal/settings/rotate-api-key", { grace_minutes: "1440" }],
      ["/portal/settings/revoke-previous-key", {}],
      ["/portal/settings/password", { new_password: "a brand new password", new_password2: "a brand new password" }],
    ] as Array<[string, Record<string, string>]>) {
      db({ reauthAgeMs: null });
      const res = await post(path, body);
      expect(res.status, path).toBe(403);
      expect(res.text).toContain("Confirm your password");
    }
  });

  it("refuses every credential change without the CSRF token", async () => {
    for (const path of [
      "/portal/settings/webhook",
      "/portal/settings/rotate-webhook-secret",
      "/portal/settings/rotate-api-key",
      "/portal/settings/confirm",
    ]) {
      db({ reauthAgeMs: 60_000 });
      const res = await withSession(request(app()).post(path)).send({ webhook_url: "https://x.example" });
      expect(res.status, path).toBe(403);
    }
  });

  it("accepts the right password and refuses the wrong one", async () => {
    db({ reauthAgeMs: null });
    const wrong = await post("/portal/settings/confirm", { password: "not it" });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain("That password is not right");

    const calls = db({ reauthAgeMs: null });
    const right = await post("/portal/settings/confirm", { password: PASSWORD });
    expect(right.status).toBe(303);
    expect(calls.some((c) => c.sql.includes("SET reauth_at = now()"))).toBe(true);
  });
});

describe("changing things", () => {
  const post = (path: string, body: Record<string, string> = {}) =>
    withSession(request(app()).post(path)).send({ _csrf: CSRF, ...body });

  it("saves a webhook URL", async () => {
    const calls = db({ reauthAgeMs: 60_000 });
    const url = "https://8.8.8.8/hook";
    const res = await post("/portal/settings/webhook", { webhook_url: url });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Webhook URL saved");
    const update = calls.find((c) => c.sql.includes("SET webhook_url"));
    expect(update!.params).toEqual([url, MERCHANT]);
  });

  it("refuses a webhook URL that points inside the network", async () => {
    db({ reauthAgeMs: 60_000 });
    const res = await post("/portal/settings/webhook", { webhook_url: "http://127.0.0.1/collect" });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/private|loopback|not allowed/i);
  });

  it("clears delivery when the URL is emptied", async () => {
    const calls = db({ reauthAgeMs: 60_000, webhookUrl: "https://8.8.8.8/hook" });
    const res = await post("/portal/settings/webhook", { webhook_url: "" });
    expect(res.text).toContain("Webhook delivery is off");
    expect(calls.find((c) => c.sql.includes("SET webhook_url"))!.params[0]).toBeNull();
  });

  it("shows a rotated API key exactly once, in the body of the POST", async () => {
    db({ reauthAgeMs: 60_000 });
    const res = await post("/portal/settings/rotate-api-key", { grace_minutes: "1440" });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/xmr_sk_[0-9a-f]{64}/);
    expect(res.text).toContain("shown once");
    // Not in a redirect, where it would reach proxy logs and history.
    expect(res.headers.location).toBeUndefined();
  });

  it("shows a rotated webhook secret and warns that the old one is dead", async () => {
    db({ reauthAgeMs: 60_000 });
    const res = await post("/portal/settings/rotate-webhook-secret");
    expect(res.text).toContain("New webhook secret");
    expect(res.text).toContain("stopped working the moment");
  });

  it("changes the password and ends other sessions", async () => {
    const calls = db({ reauthAgeMs: 60_000, sessions: 3 });
    const res = await post("/portal/settings/password", {
      new_password: "a brand new password",
      new_password2: "a brand new password",
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Password changed");
    expect(calls.some((c) => c.sql.includes("DELETE FROM portal_sessions WHERE user_id = $1 AND token_hash <> $2"))).toBe(true);
  });

  it("refuses a mismatched or weak new password", async () => {
    db({ reauthAgeMs: 60_000 });
    expect((await post("/portal/settings/password", { new_password: "aaaaaaaaaaaa", new_password2: "bbbbbbbbbbbb" })).status).toBe(400);
    db({ reauthAgeMs: 60_000 });
    const weak = await post("/portal/settings/password", { new_password: "short", new_password2: "short" });
    expect(weak.status).toBe(400);
    expect(weak.text).toContain("at least 12");
  });
});
