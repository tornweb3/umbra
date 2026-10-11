// Portal accounts and sessions.
//
// A portal account is deliberately a different credential from the API key.
// The key is a machine credential pasted into shop plugins: it cannot be
// revoked without taking the merchant's shop down, it never expires, and
// rotating it would log them out of the page they rotated it from. So the
// browser gets its own password and a revocable session, and the two
// middlewares below are never interchangeable with requireAuth.
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import type express from "express";
import { query } from "../db.js";
import { sha256Hex } from "../crypto.js";
import { readCookie } from "../cookies.js";

// promisify picks the overload without options, so the type is spelled out.
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
) => Promise<Buffer>;

export const COOKIE_NAME = "umbra_session";
export const MIN_PASSWORD_LENGTH = 12;
// Hashing is deliberately expensive, so an unbounded password is free CPU
// exhaustion for anyone who can reach the login form.
export const MAX_PASSWORD_LENGTH = 200;

/** Idle timeout: a session not used for this long is gone. */
const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS ?? 12);
/** Absolute cap, regardless of use. */
const ABSOLUTE_TTL_HOURS = Number(process.env.SESSION_ABSOLUTE_TTL_HOURS ?? 24 * 7);
/** How recently the password must have been re-entered to change a credential. */
const REAUTH_WINDOW_MS = 10 * 60_000;
/** Sliding the idle window on every page view would be a write per request. */
const TOUCH_AFTER_MS = 60_000;

// ---- passwords -------------------------------------------------------------

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
// N=32768, r=8 needs exactly 128*N*r = 32 MiB, which is Node's default maxmem,
// and hitting the limit throws rather than degrading. Ask for headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_LEN = 32;

async function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return scrypt(password.normalize("NFKC"), salt, KEY_LEN, { N: n, r, p, maxmem: SCRYPT_MAXMEM });
}

/** `scrypt$N$r$p$salt$hash`, parameters inline so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hash written with different parameters must still verify, or raising the
  // cost would lock everyone out.
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64");
    actual = await derive(password, Buffer.from(saltB64, "base64"), n, r, p);
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// A miss must cost what a hit costs, or the response time says whether an
// account exists. Built once, lazily, so startup is not slowed by 100ms of
// scrypt that most processes never need.
let decoy: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  return (decoy ??= hashPassword(randomUUID()));
}

/** Null when acceptable, otherwise the reason to show the user. */
export function passwordComplaint(password: unknown, username = ""): string | null {
  if (typeof password !== "string") return "Choose a password.";
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (username && password.toLowerCase() === username.toLowerCase()) return "The password cannot be your username.";
  if (password.startsWith("xmr_sk_")) return "That is your API key, not a password. Choose something else.";
  return null;
}

export function normaliseUsername(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// ---- accounts --------------------------------------------------------------

export interface PortalUser {
  id: string;
  merchant_id: string;
  username: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: string | null;
}

export async function countPortalUsers(): Promise<number> {
  const { rows } = await query<{ n: string }>(`SELECT count(*)::text AS n FROM portal_users`);
  return Number(rows[0].n);
}

export async function createPortalUser(merchantId: string, username: string, password: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO portal_users (merchant_id, username, password_hash) VALUES ($1, $2, $3) RETURNING id`,
    [merchantId, username, await hashPassword(password)]
  );
  return rows[0].id;
}

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "credentials" }
  | { ok: false; reason: "locked"; until: string };

/**
 * Check a username and password, with a per-account lockout.
 *
 * The in-memory rate limiter is per process and resets on restart, and an
 * attacker rotating IP addresses walks straight past it, so the throttle that
 * matters lives in the database next to the account.
 */
export async function authenticate(username: string, password: string): Promise<AuthResult> {
  const { rows } = await query<PortalUser>(
    `SELECT id, merchant_id, username, password_hash, failed_attempts, locked_until
     FROM portal_users WHERE username = $1`,
    [username]
  );
  const user = rows[0];
  if (!user) {
    await verifyPassword(password, await decoyHash());
    return { ok: false, reason: "credentials" };
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false, reason: "locked", until: user.locked_until };
  }
  if (await verifyPassword(password, user.password_hash)) {
    await query(
      `UPDATE portal_users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id]
    );
    return { ok: true, userId: user.id };
  }
  // 5 strikes, then 15 minutes, doubling per subsequent lock up to a day.
  const attempts = user.failed_attempts + 1;
  const lockMinutes = attempts < 5 ? 0 : Math.min(15 * 2 ** Math.floor(attempts / 5 - 1), 24 * 60);
  await query(
    `UPDATE portal_users SET failed_attempts = $2,
            locked_until = CASE WHEN $3::int > 0 THEN now() + make_interval(mins => $3::int) ELSE locked_until END
     WHERE id = $1`,
    [user.id, attempts, lockMinutes]
  );
  return { ok: false, reason: "credentials" };
}

export async function setPassword(userId: string, password: string): Promise<void> {
  await query(
    `UPDATE portal_users SET password_hash = $2, password_changed_at = now(),
            failed_attempts = 0, locked_until = NULL, reset_token_hash = NULL, reset_expires_at = NULL
     WHERE id = $1`,
    [userId, await hashPassword(password)]
  );
}

// ---- password recovery -----------------------------------------------------

/**
 * Issue a one-time reset token, for `npm run portal:reset`.
 *
 * The operator of a self-hosted gateway has shell access by definition, so
 * this is the recovery path rather than an emailed flow the gateway would need
 * a mail server for. Only the hash is stored, and a password is never printed:
 * the operator gets a URL and sets the password in the browser.
 */
export async function createResetToken(username: string, ttlMinutes = 60): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  const { rowCount } = await query(
    `UPDATE portal_users SET reset_token_hash = $2, reset_expires_at = now() + make_interval(mins => $3)
     WHERE username = $1`,
    [username, sha256Hex(token), ttlMinutes]
  );
  return rowCount ? token : null;
}

/** Burns the token and returns the user it belonged to. */
export async function consumeResetToken(token: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `UPDATE portal_users SET reset_token_hash = NULL, reset_expires_at = NULL
     WHERE reset_token_hash = $1 AND reset_expires_at > now() RETURNING id`,
    [sha256Hex(token)]
  );
  return rows[0]?.id ?? null;
}

// ---- sessions --------------------------------------------------------------

export interface SessionContext {
  sessionId: string;
  token: string;
  csrf: string;
  reauthAt: string | null;
  userId: string;
  username: string;
  merchant: {
    id: string;
    name: string;
    address: string;
    wallet_name: string;
    webhook_url: string | null;
    wallet_ready_at: string | null;
    wallet_error: string | null;
  };
}

export interface StartedSession {
  token: string;
  csrf: string;
  expiresAt: Date;
}

export async function startSession(userId: string, req: express.Request): Promise<StartedSession> {
  // Only the hash is stored: a read-only database leak (a backup, a log, an
  // injection that can read but not write) cannot be replayed as a session.
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(18).toString("base64url");
  const absolute = new Date(Date.now() + ABSOLUTE_TTL_HOURS * 3_600_000);
  const expiresAt = new Date(Math.min(Date.now() + TTL_HOURS * 3_600_000, absolute.getTime()));
  await query(
    `INSERT INTO portal_sessions (user_id, token_hash, csrf, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, LEAST($6::timestamptz, $7::timestamptz))`,
    [userId, sha256Hex(token), csrf, (req.get("User-Agent") ?? "").slice(0, 300), req.ip ?? null, expiresAt, absolute]
  );
  return { token, csrf, expiresAt };
}

export async function loadSession(token: string): Promise<SessionContext | null> {
  const { rows } = await query<any>(
    `SELECT s.id, s.csrf, s.reauth_at, s.last_seen_at, u.id AS user_id, u.username,
            m.id AS merchant_id, m.name, m.address, m.wallet_name, m.webhook_url,
            m.wallet_ready_at, m.wallet_error
     FROM portal_sessions s
     JOIN portal_users u ON u.id = s.user_id
     JOIN merchants m ON m.id = u.merchant_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256Hex(token)]
  );
  const r = rows[0];
  if (!r) return null;
  // Slide the idle window, but not on every page view.
  if (Date.now() - new Date(r.last_seen_at).getTime() > TOUCH_AFTER_MS) {
    await query(
      `UPDATE portal_sessions
       SET last_seen_at = now(),
           expires_at = LEAST(now() + make_interval(hours => $2), created_at + make_interval(hours => $3))
       WHERE id = $1`,
      [r.id, TTL_HOURS, ABSOLUTE_TTL_HOURS]
    );
  }
  return {
    sessionId: r.id,
    token,
    csrf: r.csrf,
    reauthAt: r.reauth_at,
    userId: r.user_id,
    username: r.username,
    merchant: {
      id: r.merchant_id,
      name: r.name,
      address: r.address,
      wallet_name: r.wallet_name,
      webhook_url: r.webhook_url,
      wallet_ready_at: r.wallet_ready_at,
      wallet_error: r.wallet_error,
    },
  };
}

export async function endSession(token: string): Promise<void> {
  await query(`DELETE FROM portal_sessions WHERE token_hash = $1`, [sha256Hex(token)]);
}

/** Used after a password change: every other session dies. */
export async function endOtherSessions(userId: string, keepToken: string): Promise<number> {
  const { rowCount } = await query(`DELETE FROM portal_sessions WHERE user_id = $1 AND token_hash <> $2`, [
    userId,
    sha256Hex(keepToken),
  ]);
  return rowCount ?? 0;
}

/** Used after a password reset: a compromise recovery kills every session. */
export async function endAllSessions(userId: string): Promise<number> {
  const { rowCount } = await query(`DELETE FROM portal_sessions WHERE user_id = $1`, [userId]);
  return rowCount ?? 0;
}

export async function markReauth(sessionId: string): Promise<void> {
  await query(`UPDATE portal_sessions SET reauth_at = now() WHERE id = $1`, [sessionId]);
}

export async function sweepExpiredSessions(): Promise<void> {
  await query(`DELETE FROM portal_sessions WHERE expires_at < now()`);
}

// ---- cookies ---------------------------------------------------------------

/**
 * Whether this request is effectively HTTPS.
 *
 * Both failure modes are bad, so it cannot be a constant: marking the cookie
 * Secure unconditionally breaks the plain-HTTP localhost first run with a
 * silent, infinite login loop, and never marking it hands the session token to
 * anyone watching a misconfigured proxy's upstream traffic.
 */
export function isSecureRequest(req: express.Request, baseUrl: string): boolean {
  if (baseUrl.startsWith("https://")) return true;
  // Honours X-Forwarded-Proto only when TRUST_PROXY is configured.
  return req.protocol === "https";
}

export function setSessionCookie(
  req: express.Request,
  res: express.Response,
  baseUrl: string,
  token: string,
  expiresAt: Date
): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    // Lax, not Strict: a link from the Umbrel dashboard into the portal must
    // not land logged out. It still blocks cross-site POST, which is the
    // CSRF-relevant case.
    sameSite: "lax",
    secure: isSecureRequest(req, baseUrl),
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: express.Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

// ---- middleware ------------------------------------------------------------

export const portal = (req: express.Request): SessionContext => (req as any).portal;

/**
 * Require a logged-in session.
 *
 * This must never be mounted on /api/*. The API authenticates with a Bearer
 * key; if a cookie also worked there, every existing API route would become
 * reachable from any site the merchant happens to be visiting, including the
 * webhook URL change, which is the most valuable attack in the product.
 */
export function requireSession(): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE_NAME);
      const context = token ? await loadSession(token) : null;
      if (!context) {
        clearSessionCookie(res);
        if (req.method === "GET") return res.redirect(303, "/portal/login");
        return res.status(401).send("Your session has expired. Log in again.");
      }
      (req as any).portal = context;
      next();
    } catch (e) {
      // A database hiccup here must not hang the request.
      next(e);
    }
  };
}

export function requireCsrf(baseUrl: string): express.RequestHandler {
  const expected = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return null;
    }
  })();
  return (req, res, next) => {
    // Layer one: a cross-site form post that arrives with an Origin we do not
    // recognise is refused before the token is even compared.
    const origin = req.get("Origin");
    if (origin && expected && origin !== expected) return res.status(403).send("Refused: cross-site request.");
    // Layer two: the synchroniser token, which only a page we rendered has.
    const given = String((req.body as any)?._csrf ?? "");
    const want = portal(req)?.csrf ?? "";
    const a = Buffer.from(given);
    const b = Buffer.from(want);
    if (!want || a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(403).send("Refused: this form expired. Reload the page and try again.");
    }
    next();
  };
}

/**
 * Credential changes need the password again.
 *
 * Pointing webhooks at an attacker's server is the highest-value action in the
 * product: every payment notification goes to them, and with a rotated secret
 * they can forge events a merchant's shop will treat as paid.
 */
export function requireRecentAuth(): express.RequestHandler {
  return (req, res, next) => {
    const at = portal(req)?.reauthAt;
    if (at && Date.now() - new Date(at).getTime() < REAUTH_WINDOW_MS) return next();
    res.status(403).send("Confirm your password before changing credentials.");
  };
}
