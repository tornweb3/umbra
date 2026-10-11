// The merchant console. Mounted under /portal, session-authenticated, and
// strictly separate from /api/*: see requireSession for why that matters.
import type express from "express";
import { route } from "../http.js";
import { query } from "../db.js";
import { xmrFromAtomic } from "../money.js";
import { html } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { statusBadge, timestamp, when } from "../ui/components.js";
import { mountAuthRoutes } from "./auth.js";
import { portalHeaders } from "./headers.js";
import { mountInvoiceRoutes } from "./invoices.js";
import { portalNav } from "./nav.js";
import { mountSettingsRoutes } from "./settings.js";
import { mountSetupRoutes } from "./setup.js";
import { clearSessionCookie, endSession, portal, requireCsrf, requireSession } from "./session.js";

export interface PortalOptions {
  baseUrl: string;
  network: string;
}

export function mountPortalRoutes(app: express.Express, opts: PortalOptions): void {
  app.use("/portal", portalHeaders());
  mountSetupRoutes(app, opts);
  mountAuthRoutes(app, opts);
  mountInvoiceRoutes(app, { baseUrl: opts.baseUrl });
  mountSettingsRoutes(app, { baseUrl: opts.baseUrl });

  const session = requireSession();
  const csrf = requireCsrf(opts.baseUrl);

  app.get("/portal", session, route(async (req, res) => {
    const p = portal(req);
    const m = p.merchant;
    const provisioning = !m.wallet_ready_at;

    // Two small queries rather than one join: counting invoices across a join
    // to payments would count an invoice once per payment.
    const counts = await query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM invoices WHERE merchant_id = $1 GROUP BY status`,
      [m.id]
    );
    const by = (s: string) => counts.rows.find((r) => r.status === s)?.n ?? 0;
    const received = await query<{ total: string }>(
      `SELECT COALESCE(SUM(p.amount_atomic), 0)::text AS total
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.merchant_id = $1 AND p.confirmed_at IS NOT NULL AND p.confirmed_at > now() - interval '30 days'`,
      [m.id]
    );
    const body = html`<h1>${m.name}</h1>
<p class="muted">Signed in as ${p.username}</p>

${when(
  provisioning && !m.wallet_error,
  () => html`<div class="banner info">Your view-only wallet is being prepared. Invoice creation
answers 503 until it is ready, which usually takes a few minutes. This needs the worker process
to be running.</div>`
)}
${when(
  provisioning && m.wallet_error,
  () => html`<div class="banner error">The wallet could not be prepared: ${m.wallet_error}. The
worker retries on every pass; check that monero-wallet-rpc is reachable.</div>`
)}
${when(
  !m.webhook_url,
  () => html`<div class="banner info">No webhook URL is set, so nothing is notified when a payment
confirms. That is fine if you use the hosted checkout page and poll the API.</div>`
)}

<div class="stats">
<div class="stat"><span class="n">${xmrFromAtomic(BigInt(received.rows[0]?.total ?? "0"))}</span><span class="l">XMR received, 30 days</span></div>
<div class="stat"><span class="n">${by("confirmed")}</span><span class="l">confirmed</span></div>
<div class="stat"><span class="n">${by("detected")}</span><span class="l">awaiting confirmations</span></div>
<div class="stat"><span class="n">${by("pending")}</span><span class="l">awaiting payment</span></div>
</div>

<div class="card left">
<h2>Account</h2>
<table>
<tr><th>Payout address</th><td class="mono">${m.address}</td></tr>
<tr><th>Webhook URL</th><td>${m.webhook_url ?? html`<span class="muted">none</span>`}</td></tr>
<tr><th>Wallet</th><td>${provisioning ? statusBadge("pending", " preparing") : statusBadge("confirmed", " ready")}</td></tr>
<tr><th>Ready since</th><td>${timestamp(m.wallet_ready_at)}</td></tr>
</table>
</div>

<p><a class="button" href="/portal/invoices">Invoices</a> <a class="button secondary" href="/portal/settings">Settings</a></p>
<p class="muted">The Shopify connection is still API-only, documented in
<span class="mono">docs/shopify.md</span>.</p>

<form method="post" action="/portal/logout">
<input type="hidden" name="_csrf" value="${p.csrf}">
<button class="secondary" type="submit">Log out</button>
</form>`;
    res.send(layout({ title: m.name, body, chrome: "portal", nav: portalNav("overview") }));
  }));

  // POST only, so no <img src> can trigger it, and CSRF-checked like any
  // other mutation. Registered here rather than in auth.ts because this is
  // where the session and token middleware live.
  app.post("/portal/logout", session, csrf, route(async (req, res) => {
    await endSession(portal(req).token);
    clearSessionCookie(res);
    res.redirect(303, "/portal/login");
  }));
}
