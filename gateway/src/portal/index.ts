// The merchant console. Mounted under /portal, session-authenticated, and
// strictly separate from /api/*: see requireSession for why that matters.
import type express from "express";
import { html } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { statusBadge, timestamp, when } from "../ui/components.js";
import { mountAuthRoutes } from "./auth.js";
import { portalHeaders } from "./headers.js";
import { mountSetupRoutes } from "./setup.js";
import { clearSessionCookie, endSession, portal, requireCsrf, requireSession } from "./session.js";

export interface PortalOptions {
  baseUrl: string;
  network: string;
}

export function portalNav(active: string): ReturnType<typeof html> {
  const link = (href: string, label: string, key: string) =>
    html`<a href="${href}" aria-current="${key === active ? "page" : "false"}">${label}</a>`;
  return html`${link("/portal", "Overview", "overview")}`;
}

export function mountPortalRoutes(app: express.Express, opts: PortalOptions): void {
  app.use("/portal", portalHeaders());
  mountSetupRoutes(app, opts);
  mountAuthRoutes(app, opts);

  const session = requireSession();
  const csrf = requireCsrf(opts.baseUrl);

  app.get("/portal", session, (req, res) => {
    const p = portal(req);
    const m = p.merchant;
    const provisioning = !m.wallet_ready_at;
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

<div class="card left">
<h2>Account</h2>
<table>
<tr><th>Payout address</th><td class="mono">${m.address}</td></tr>
<tr><th>Webhook URL</th><td>${m.webhook_url ?? html`<span class="muted">none</span>`}</td></tr>
<tr><th>Wallet</th><td>${provisioning ? statusBadge("pending", " preparing") : statusBadge("confirmed", " ready")}</td></tr>
<tr><th>Ready since</th><td>${timestamp(m.wallet_ready_at)}</td></tr>
</table>
</div>

<p class="muted">Invoices, settings and the Shopify connection arrive in the next releases. The
API is fully usable today: see <span class="mono">docs/api.md</span>.</p>

<form method="post" action="/portal/logout">
<input type="hidden" name="_csrf" value="${p.csrf}">
<button class="secondary" type="submit">Log out</button>
</form>`;
    res.send(layout({ title: m.name, body, chrome: "portal", nav: portalNav("overview") }));
  });

  // POST only, so no <img src> can trigger it, and CSRF-checked like any
  // other mutation. Registered here rather than in auth.ts because this is
  // where the session and token middleware live.
  app.post("/portal/logout", session, csrf, async (req, res) => {
    await endSession(portal(req).token);
    clearSessionCookie(res);
    res.redirect(303, "/portal/login");
  });
}
