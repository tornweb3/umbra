import { randomBytes, scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), end: async () => {} },
}));

import {
  authenticate,
  COOKIE_NAME,
  hashPassword,
  isSecureRequest,
  MAX_PASSWORD_LENGTH,
  passwordComplaint,
  normaliseUsername,
  requireCsrf,
  requireRecentAuth,
  setSessionCookie,
  verifyPassword,
} from "../src/portal/session.js";

beforeEach(() => query.mockReset());

describe("password hashing", () => {
  it("round-trips and rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently each time", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("still verifies a hash written with weaker parameters", async () => {
    // The parameters live in the stored string so the cost can be raised
    // later. If old hashes stopped verifying, raising it would lock everyone
    // out, so a hash from the cheaper settings has to keep working.
    const salt = randomBytes(16);
    const legacyHash = scryptSync("portable password", salt, 32, { N: 16384, r: 8, p: 1 });
    const legacy = `scrypt$16384$8$1$${salt.toString("base64")}$${legacyHash.toString("base64")}`;
    expect(await verifyPassword("portable password", legacy)).toBe(true);
    expect(await verifyPassword("the wrong one", legacy)).toBe(false);
  });

  it("costs enough to be worth having", async () => {
    // 32 MiB of scrypt is about 100ms. If this ever comes back near zero, the
    // parameters have silently stopped applying.
    const started = Date.now();
    await hashPassword("timing check for the parameters");
    expect(Date.now() - started).toBeGreaterThan(20);
  });

  it("refuses a malformed stored hash instead of throwing", async () => {
    for (const bad of ["", "plain", "scrypt$x$y$z$a$b", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});

describe("password policy", () => {
  it("requires a reasonable length", () => {
    expect(passwordComplaint("short")).toMatch(/at least 12/);
    expect(passwordComplaint("x".repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(/at most/);
    expect(passwordComplaint("a decent password")).toBeNull();
  });

  it("rejects the username and an API key as passwords", () => {
    expect(passwordComplaint("mymerchantname", "mymerchantname")).toMatch(/cannot be your username/);
    expect(passwordComplaint("xmr_sk_" + "a".repeat(64))).toMatch(/API key/);
  });

  it("lowercases and trims usernames", () => {
    expect(normaliseUsername("  Shop@Example.COM ")).toBe("shop@example.com");
    expect(normaliseUsername(undefined)).toBe("");
  });
});

describe("authenticate", () => {
  it("does not reveal whether an account exists", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await authenticate("nobody", "some password");
    expect(res).toEqual({ ok: false, reason: "credentials" });
    // Only the lookup ran: no update, and the decoy hash was computed so the
    // response time looks like a real miss.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses a locked account without checking the password", async () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    query.mockResolvedValue({
      rows: [{ id: "u1", merchant_id: "m1", username: "u", password_hash: "x", failed_attempts: 5, locked_until: until }],
      rowCount: 1,
    });
    const res = await authenticate("u", "whatever");
    expect(res).toEqual({ ok: false, reason: "locked", until });
  });

  it("locks after five failures, then doubles", async () => {
    const stored = await hashPassword("the right password");
    const attempt = async (failed: number) => {
      query.mockReset();
      query.mockResolvedValueOnce({
        rows: [{ id: "u1", merchant_id: "m1", username: "u", password_hash: stored, failed_attempts: failed, locked_until: null }],
        rowCount: 1,
      });
      query.mockResolvedValue({ rows: [], rowCount: 1 });
      await authenticate("u", "wrong");
      const update = query.mock.calls.find((c) => String(c[0]).includes("UPDATE portal_users"));
      return (update![1] as unknown[])[2] as number;
    };
    expect(await attempt(0)).toBe(0); // 1st failure: no lock yet
    expect(await attempt(3)).toBe(0); // 4th
    expect(await attempt(4)).toBe(15); // 5th: 15 minutes
    expect(await attempt(9)).toBe(30); // 10th: doubles
    expect(await attempt(99)).toBe(1440); // capped at a day
  });

  it("clears the counter on success", async () => {
    const stored = await hashPassword("the right password");
    query.mockResolvedValueOnce({
      rows: [{ id: "u1", merchant_id: "m1", username: "u", password_hash: stored, failed_attempts: 3, locked_until: null }],
      rowCount: 1,
    });
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    expect(await authenticate("u", "the right password")).toEqual({ ok: true, userId: "u1" });
    expect(String(query.mock.calls[1][0])).toContain("failed_attempts = 0");
  });
});

describe("session cookie", () => {
  const res = () => {
    const headers: Record<string, unknown> = {};
    return {
      headers,
      cookie(name: string, value: string, opts: Record<string, unknown>) {
        headers.cookie = { name, value, opts };
      },
    } as any;
  };

  it("is marked Secure behind HTTPS", () => {
    const r = res();
    setSessionCookie({ protocol: "https" } as any, r, "https://pay.example.com", "tok", new Date());
    expect(r.headers.cookie.name).toBe(COOKIE_NAME);
    expect(r.headers.cookie.opts).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  });

  it("is not marked Secure on a plain-HTTP first run", () => {
    // Unconditional Secure here is an invisible infinite login loop.
    const r = res();
    setSessionCookie({ protocol: "http" } as any, r, "http://localhost:3000", "tok", new Date());
    expect(r.headers.cookie.opts.secure).toBe(false);
  });

  it("trusts the base URL even when the proxy does not forward the scheme", () => {
    expect(isSecureRequest({ protocol: "http" } as any, "https://pay.example.com")).toBe(true);
    expect(isSecureRequest({ protocol: "https" } as any, "http://localhost:3000")).toBe(true);
    expect(isSecureRequest({ protocol: "http" } as any, "http://localhost:3000")).toBe(false);
  });
});

describe("requireCsrf", () => {
  const run = (opts: { origin?: string; token?: string; sessionCsrf?: string }) => {
    const req: any = { get: (h: string) => (h === "Origin" ? opts.origin : undefined), body: { _csrf: opts.token } };
    if (opts.sessionCsrf !== undefined) req.portal = { csrf: opts.sessionCsrf };
    const res: any = { code: 0, body: "", status(c: number) { this.code = c; return this; }, send(b: string) { this.body = b; return this; } };
    let nexted = false;
    requireCsrf("https://pay.example.com")(req, res, () => { nexted = true; });
    return { nexted, res };
  };

  it("accepts a matching token", () => {
    expect(run({ token: "abc", sessionCsrf: "abc" }).nexted).toBe(true);
  });

  it("refuses a missing, wrong or length-mismatched token", () => {
    expect(run({ token: "", sessionCsrf: "abc" }).nexted).toBe(false);
    expect(run({ token: "abd", sessionCsrf: "abc" }).nexted).toBe(false);
    expect(run({ token: "abcdef", sessionCsrf: "abc" }).nexted).toBe(false);
    expect(run({ sessionCsrf: "abc" }).res.code).toBe(403);
  });

  it("refuses a session with no csrf value at all", () => {
    expect(run({ token: "abc" }).nexted).toBe(false);
  });

  it("refuses a foreign Origin before looking at the token", () => {
    const r = run({ origin: "https://evil.example", token: "abc", sessionCsrf: "abc" });
    expect(r.nexted).toBe(false);
    expect(r.res.body).toMatch(/cross-site/);
  });

  it("accepts our own Origin", () => {
    expect(run({ origin: "https://pay.example.com", token: "abc", sessionCsrf: "abc" }).nexted).toBe(true);
  });
});

describe("requireRecentAuth", () => {
  const run = (reauthAt: string | null) => {
    const req: any = { portal: { reauthAt } };
    const res: any = { code: 0, status(c: number) { this.code = c; return this; }, send() { return this; } };
    let nexted = false;
    requireRecentAuth()(req, res, () => { nexted = true; });
    return { nexted, code: res.code };
  };

  it("allows a password confirmed in the last ten minutes", () => {
    expect(run(new Date(Date.now() - 60_000).toISOString()).nexted).toBe(true);
  });

  it("refuses an older confirmation or none at all", () => {
    expect(run(new Date(Date.now() - 20 * 60_000).toISOString()).nexted).toBe(false);
    expect(run(null).code).toBe(403);
  });
});
