// Rate limiters, created once and imported.
//
// Each rateLimit() call closes over its own Map of counters, so calling it
// twice with the same options does not share a limit: it doubles it. That is
// invisible in review and in tests, which is why the shared ones live here
// and route files import them instead of declaring their own.
//
// Everything here is per process and resets on restart, so it slows a single
// client rather than stopping a distributed one. The durable limits, the ones
// that matter, live next to the data: the per-account lockout in
// portal_users, and the per-page cap on live invoices.
import { merchant } from "./http.js";
import { portal } from "./portal/session.js";
import { rateLimit } from "./security.js";

/** Buyer-facing pages and their polling. Generous: the buyer is not the threat. */
export const publicLimit = rateLimit({ windowMs: 60_000, max: 120 });

/** Authenticated API, keyed by account rather than address. */
export const merchantLimit = rateLimit({ windowMs: 60_000, max: 60, key: (req) => merchant(req).id });

/** Account creation. Writes a wallet file eventually, so it stays tight. */
export const signupLimit = rateLimit({ windowMs: 3_600_000, max: 5, message: "too many signup attempts" });

/** Buyer pay links from an order email. */
export const payLinkLimit = rateLimit({ windowMs: 60_000, max: 30 });

/**
 * Order-number lookup: the one buyer route where a guessable input could
 * enumerate orders, so it is the tightest of them.
 */
export const orderLookupLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: "too many attempts, please wait a minute",
});

/** Anything in the console keyed to the merchant, where the cost is the wallet lock. */
export const merchantActionLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  key: (req) => portal(req).merchant.id,
});
