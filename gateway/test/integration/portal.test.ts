// Integration: the session SQL against a real Postgres.
//
// Unit tests mock the database, which means none of the SQL in session.ts is
// ever executed by them. Run these with a database:
//
//   TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db npm test
//
// Without TEST_DATABASE_URL they skip, so `npm test` still needs nothing
// installed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, query } from "../../src/db.js";
import {
  authenticate,
  countPortalUsers,
  consumeResetToken,
  createPortalUser,
  createResetToken,
  endOtherSessions,
  endSession,
  loadSession,
  markReauth,
  setPassword,
  startSession,
  sweepExpiredSessions,
} from "../../src/portal/session.js";
import { encrypt } from "../../src/crypto.js";

const live = Boolean(process.env.TEST_DATABASE_URL);
const req = { get: () => "vitest", ip: "127.0.0.1" } as any;

const USERNAME = `itest_${Date.now()}`;
const PASSWORD = "an integration password";
let merchantId = "";
let userId = "";

describe.skipIf(!live)("portal sessions against a real database", () => {
  beforeAll(async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO merchants (name, address, view_key_enc, wallet_name, api_key_hash, webhook_url, webhook_secret, wallet_ready_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, now()) RETURNING id`,
      [
        "integration test",
        "5" + "Z".repeat(94),
        encrypt("a".repeat(64)),
        `itest_${Date.now()}`,
        `itest_${Date.now()}`,
        "secret",
      ]
    );
    merchantId = rows[0].id;
    userId = await createPortalUser(merchantId, USERNAME, PASSWORD);
  });

  afterAll(async () => {
    if (merchantId) await query(`DELETE FROM merchants WHERE id = $1`, [merchantId]);
    await pool.end().catch(() => {});
  });

  it("creates an account that can be counted and authenticated", async () => {
    expect(await countPortalUsers()).toBeGreaterThan(0);
    expect(await authenticate(USERNAME, PASSWORD)).toEqual({ ok: true, userId });
    expect(await authenticate(USERNAME, "wrong")).toEqual({ ok: false, reason: "credentials" });
    // The failure counter is real, and a success clears it.
    const after = await query<{ failed_attempts: number }>(`SELECT failed_attempts FROM portal_users WHERE id = $1`, [userId]);
    expect(after.rows[0].failed_attempts).toBe(1);
    await authenticate(USERNAME, PASSWORD);
    const cleared = await query<{ failed_attempts: number }>(`SELECT failed_attempts FROM portal_users WHERE id = $1`, [userId]);
    expect(cleared.rows[0].failed_attempts).toBe(0);
  });

  it("starts a session that loads the merchant with it, and ends it", async () => {
    const started = await startSession(userId, req);
    expect(started.token).toMatch(/^[\w-]{43}$/);
    const ctx = await loadSession(started.token);
    expect(ctx).toBeTruthy();
    expect(ctx!.username).toBe(USERNAME);
    expect(ctx!.merchant.id).toBe(merchantId);
    expect(ctx!.merchant.wallet_ready_at).toBeTruthy();
    expect(ctx!.csrf).toBe(started.csrf);

    // The raw token is never stored, so it cannot be read back out.
    const stored = await query<{ token_hash: string }>(`SELECT token_hash FROM portal_sessions WHERE id = $1`, [ctx!.sessionId]);
    expect(stored.rows[0].token_hash).not.toBe(started.token);

    await markReauth(ctx!.sessionId);
    expect((await loadSession(started.token))!.reauthAt).toBeTruthy();

    await endSession(started.token);
    expect(await loadSession(started.token)).toBeNull();
  });

  it("rejects an unknown or expired token", async () => {
    expect(await loadSession("not-a-real-token")).toBeNull();
    const started = await startSession(userId, req);
    await query(`UPDATE portal_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = encode(digest($1, 'sha256'), 'hex')`, [
      started.token,
    ]).catch(async () => {
      // pgcrypto may be absent; expire every session for this user instead.
      await query(`UPDATE portal_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [userId]);
    });
    expect(await loadSession(started.token)).toBeNull();
    await sweepExpiredSessions();
    const left = await query<{ n: string }>(`SELECT count(*)::text AS n FROM portal_sessions WHERE user_id = $1`, [userId]);
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it("logs out everywhere but here", async () => {
    const keep = await startSession(userId, req);
    await startSession(userId, req);
    await startSession(userId, req);
    expect(await endOtherSessions(userId, keep.token)).toBe(2);
    expect(await loadSession(keep.token)).toBeTruthy();
  });

  it("burns a reset token after one use", async () => {
    const token = await createResetToken(USERNAME);
    expect(token).toBeTruthy();
    expect(await consumeResetToken(token!)).toBe(userId);
    expect(await consumeResetToken(token!)).toBeNull();
    expect(await createResetToken("nobody-at-all")).toBeNull();
  });

  it("changes a password and invalidates the old one", async () => {
    await setPassword(userId, "a different long password");
    expect(await authenticate(USERNAME, "a different long password")).toEqual({ ok: true, userId });
    expect(await authenticate(USERNAME, PASSWORD)).toEqual({ ok: false, reason: "credentials" });
  });
});
