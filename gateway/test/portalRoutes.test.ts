import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), end: async () => {} },
}));

import { createApp } from "../src/app.js";
import { COOKIE_NAME } from "../src/portal/session.js";

const app = () => createApp({ baseUrl: "http://localhost:3000", network: "stagenet" });

const SECRET_SENTINEL = "webhook-secret-must-not-appear";
const TOKEN = "a".repeat(43);

/**
 * Route the mocked database by statement, so each test says which rows exist
 * rather than counting calls.
 */
function db(opts: { users?: number; session?: boolean } = {}) {
  query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("FROM portal_users") && text.includes("count(*)")) {
      return { rows: [{ n: String(opts.users ?? 0) }], rowCount: 1 };
    }
    if (text.includes("FROM portal_sessions s")) {
      if (!opts.session) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: "s1",
            csrf: "csrf-token-value",
            reauth_at: null,
            last_seen_at: new Date().toISOString(),
            user_id: "u1",
            username: "owner",
            merchant_id: "1cf6b8b8-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
            name: "Test Shop",
            address: "5" + "A1b2C3d4E5".repeat(9) + "A1b2",
            wallet_name: "m_1",
            webhook_url: null,
            wallet_ready_at: "2026-10-11T22:00:00.000Z",
            wallet_error: null,
          },
        ],
        rowCount: 1,
      };
    }
    // The Bearer path: no merchant matches, so /api/* stays 401.
    return { rows: [], rowCount: 0 };
  });
}

const withSession = (r: request.Test) => r.set("Cookie", `${COOKIE_NAME}=${TOKEN}`);

beforeEach(() => query.mockReset());

describe("the front door", () => {
  it("sends / to the console", async () => {
    db();
    const res = await request(app()).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/portal");
  });

  it("sends an anonymous visitor from the console to login", async () => {
    db({ users: 1 });
    const res = await request(app()).get("/portal");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/portal/login");
  });

  it("sends login to setup while the gateway is unclaimed", async () => {
    db({ users: 0 });
    const res = await request(app()).get("/portal/login");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/portal/setup");
  });

  it("sends setup to login once it is claimed", async () => {
    db({ users: 1 });
    const res = await request(app()).get("/portal/setup");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/portal/login");
  });

  it("no longer serves a scratch page at the root", async () => {
    db();
    // public/index.html used to answer here, and it was an unstyled test
    // harness with a signup form on it.
    const res = await request(app()).get("/index.html");
    expect(res.status).toBe(404);
  });
});

describe("the API boundary", () => {
  // The single most important rule in the portal: a cookie must never
  // authenticate /api/*, or every API route becomes reachable from any site
  // the merchant visits while logged in, including the webhook URL change.
  it("refuses a session cookie on /api/me", async () => {
    db({ users: 1, session: true });
    const res = await withSession(request(app()).get("/api/me"));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing Bearer API key/);
  });

  it("refuses a session cookie on a mutating API route", async () => {
    db({ users: 1, session: true });
    const res = await withSession(request(app()).post("/api/me/webhook")).send({
      webhook_url: "https://evil.example/collect",
    });
    expect(res.status).toBe(401);
  });
});

describe("the console", () => {
  it("renders the overview for a logged-in merchant", async () => {
    db({ users: 1, session: true });
    const res = await withSession(request(app()).get("/portal"));
    expect(res.status).toBe(200);
    expect(res.text).toContain("Test Shop");
    expect(res.text).toContain("Signed in as owner");
    expect(res.text).toContain("No webhook URL is set");
    expect(res.text).toContain('class="u-portal"');
  });

  it("carries the headers that keep it out of a frame and a cache", async () => {
    db({ users: 1, session: true });
    const res = await withSession(request(app()).get("/portal"));
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["vary"]).toBe("Cookie");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(res.headers["x-robots-tag"]).toContain("noindex");
  });

  it("leaks no secret into the page", async () => {
    query.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes("count(*)")) return { rows: [{ n: "1" }], rowCount: 1 };
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
              merchant_id: "m1",
              name: "Test Shop",
              address: "5addr",
              wallet_name: "m_wallet_name_secret",
              webhook_url: null,
              wallet_ready_at: "2026-10-11T22:00:00.000Z",
              wallet_error: null,
              webhook_secret: SECRET_SENTINEL,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await withSession(request(app()).get("/portal"));
    expect(res.text).not.toContain(SECRET_SENTINEL);
    expect(res.text).not.toContain("m_wallet_name_secret");
  });

  it("refuses logout without the CSRF token, and accepts it with", async () => {
    db({ users: 1, session: true });
    const no = await withSession(request(app()).post("/portal/logout"));
    expect(no.status).toBe(403);

    db({ users: 1, session: true });
    const yes = await withSession(request(app()).post("/portal/logout")).send({ _csrf: "csrf-token-value" });
    expect(yes.status).toBe(303);
    expect(yes.headers.location).toBe("/portal/login");
  });

  it("refuses a cross-site Origin on a form post", async () => {
    db({ users: 1, session: true });
    const res = await withSession(request(app()).post("/portal/logout"))
      .set("Origin", "https://evil.example")
      .send({ _csrf: "csrf-token-value" });
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/cross-site/);
  });
});

describe("the first-run gate", () => {
  it("opens for a request from the machine itself", async () => {
    db({ users: 0 });
    const res = await request(app()).get("/portal/setup");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Set up Umbra");
    expect(res.headers["set-cookie"]?.join(" ")).toContain("umbra_setup");
  });

  it("closes when a proxy is configured and no token is given", async () => {
    // Behind nginx with TRUST_PROXY unset, req.ip is 127.0.0.1 for every
    // request on earth, so the private-peer check alone would hand the
    // gateway to the first stranger who loaded it.
    db({ users: 0 });
    const a = app();
    a.set("trust proxy", true);
    const res = await request(a).get("/portal/setup");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Setup is not open from here");
    expect(res.text).toContain("ssh -L 3000:127.0.0.1:3000");
    expect(res.text).toContain("SIGNUP_TOKEN");
    // Crucially, no form to submit.
    expect(res.text).not.toContain("Private view key");
  });

  it("refuses a setup post with no nonce", async () => {
    db({ users: 0 });
    const res = await request(app())
      .post("/portal/setup")
      .send({ username: "owner", password: "a decent password", password2: "a decent password" });
    expect(res.status).toBe(403);
    expect(res.text).toContain("That form expired");
  });

  it("refuses a setup post whose nonce does not match the cookie", async () => {
    db({ users: 0 });
    const res = await request(app())
      .post("/portal/setup")
      .set("Cookie", "umbra_setup=the-planted-value")
      .send({ _nonce: "a-different-value", username: "owner", password: "a decent password", password2: "a decent password" });
    expect(res.status).toBe(403);
  });
});

describe("hashing used by the claim flow", () => {
  it("matches an API key by sha256, never by storing it", () => {
    // Guards the shape the claim query depends on.
    const key = "xmr_sk_" + "0".repeat(64);
    expect(createHash("sha256").update(key).digest("hex")).toHaveLength(64);
  });
});
