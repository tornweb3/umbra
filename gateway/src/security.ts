// Hardening for a publicly reachable deployment: signup gating, rate limits,
// error responses that don't leak internals, and SSRF checks on the URLs
// merchants ask us to call.
import type express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Reverse proxies sit in front in production; without this every client looks
 *  like the proxy and rate limits apply to all of them at once. */
export function configureProxyTrust(app: express.Express): void {
  const trust = process.env.TRUST_PROXY ?? "";
  if (!trust || trust === "false") return;
  app.set("trust proxy", /^\d+$/.test(trust) ? Number(trust) : trust);
  console.log(`trusting proxy: ${trust}`);
}

/** Logs the real error with a reference the caller can quote, returns neither. */
export function serverError(res: express.Response, err: unknown, context: string): void {
  const ref = randomUUID().slice(0, 8);
  console.error(`[${ref}] ${context}:`, err instanceof Error ? err.stack ?? err.message : err);
  if (!res.headersSent) res.status(500).json({ error: "internal error", reference: ref });
}

// ---- signup gating ---------------------------------------------------------

const SIGNUP_TOKEN = process.env.SIGNUP_TOKEN ?? "";

/**
 * Account creation eventually costs a wallet file and minutes of the global
 * wallet lock (the worker pays that cost, not this request), so it is closed
 * unless the operator sets SIGNUP_TOKEN. Most deployments serve one merchant:
 * open it, sign up, close it again.
 */
export function requireSignupToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!SIGNUP_TOKEN) {
    res.status(403).json({ error: "signup is disabled on this gateway" });
    return;
  }
  const given = String(req.get("X-Signup-Token") ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(SIGNUP_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ error: "invalid signup token" });
    return;
  }
  next();
}

// ---- rate limiting ---------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter, in memory. Enough for a single-process gateway; put a
 * limiter in the reverse proxy too if you run several.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  /** Defaults to the client IP. Authenticated routes key by merchant instead. */
  key?: (req: express.Request) => string;
  message?: string;
}): express.RequestHandler {
  const buckets = new Map<string, Bucket>();
  const { windowMs, max, message = "too many requests" } = options;

  return (req, res, next) => {
    const id = options.key?.(req) ?? req.ip ?? "unknown";
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      // Opportunistic sweep so the map can't grow without bound.
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

// ---- outbound URL safety ---------------------------------------------------

export class UnsafeUrlError extends Error {}

const ALLOW_PRIVATE = (process.env.ALLOW_PRIVATE_WEBHOOKS ?? "").toLowerCase() === "true";
if (ALLOW_PRIVATE) console.warn("ALLOW_PRIVATE_WEBHOOKS=true: webhooks may target private addresses");

function ipv4IsPrivate(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier NAT
    (a === 169 && b === 254) || // link-local, covers cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function ipv6IsPrivate(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0];
  if (addr === "::1" || addr === "::") return true;
  // IPv4-mapped (::ffff:10.0.0.1) is still an IPv4 destination.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  const head = parseInt(addr.split(":")[0] || "0", 16);
  if ((head & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((head & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return ipv4IsPrivate(ip);
  if (version === 6) return ipv6IsPrivate(ip);
  return true; // not an IP literal: caller resolves first
}

/**
 * Rejects URLs that resolve inside the gateway's own network. Without this a
 * merchant could point their webhook at localhost or a cloud metadata endpoint
 * and use the gateway as a proxy into it. Checked when the URL is saved and
 * again before each delivery, since DNS can change in between.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("webhook_url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("webhook_url must be an http(s) URL");
  }
  if (ALLOW_PRIVATE) return;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("webhook_url must not point at a private address");
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UnsafeUrlError(`webhook_url host does not resolve: ${host}`);
  }
  // Every answer must be public: one private record is enough to be abused.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new UnsafeUrlError("webhook_url must not point at a private address");
  }
}
