// The invoice pages: list, detail, and the form that creates one.
import type express from "express";
import { query } from "../db.js";
import { UUID_RE } from "../http.js";
import { createInvoice, InvoiceInputError, WalletNotReadyError } from "../invoices.js";
import {
  INVOICE_STATUSES,
  INVOICE_SELECT,
  invoiceJson,
  listInvoices,
  type InvoiceView,
} from "../invoiceQueries.js";
import { xmrFromAtomic } from "../money.js";
import { SUPPORTED_CURRENCIES } from "../rates.js";
import { rateLimit, serverError } from "../security.js";
import { statusBadge, timestamp, when } from "../ui/components.js";
import { html, safeUrl, type SafeHtml } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { portal, requireCsrf, requireSession } from "./session.js";
import { portalNav } from "./nav.js";

export interface InvoiceRoutesOptions {
  baseUrl: string;
}

function money(inv: InvoiceView): SafeHtml {
  return html`<span class="mono">${inv.amount_due_xmr}</span> XMR${when(
    inv.price_amount && inv.price_currency,
    () => html` <span class="muted">(${inv.price_amount} ${inv.price_currency})</span>`
  )}`;
}

function listPage(
  page: { invoices: InvoiceView[]; nextBefore: string | null },
  filters: { status: string; q: string }
): string {
  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (filters.status) p.set("status", filters.status);
    if (filters.q) p.set("q", filters.q);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/portal/invoices?${s}` : "/portal/invoices";
  };

  const body = html`<h1>Invoices</h1>
<form method="get" action="/portal/invoices" class="filters">
<label for="q">Search</label>
<input id="q" name="q" value="${filters.q}" placeholder="description or invoice id">
<label for="status">Status</label>
<select id="status" name="status">
<option value="">any status</option>
${INVOICE_STATUSES.map(
  (s) => html`<option value="${s}" ${filters.status === s ? "selected" : ""}>${s}</option>`
)}
</select>
<button type="submit">Filter</button>
</form>

${when(
  page.invoices.length === 0,
  () => html`<div class="card">No invoices${when(filters.status || filters.q, () => html` match that filter`)} yet.
<p><a class="button" href="/portal/invoices/new">Create one</a></p></div>`
)}
${when(
  page.invoices.length > 0,
  () => html`<table>
<thead><tr><th>Created</th><th>Amount</th><th>Received</th><th>Status</th><th>Description</th></tr></thead>
<tbody>
${page.invoices.map(
  (inv) => html`<tr>
<td>${timestamp(inv.created_at)}</td>
<td>${money(inv)}</td>
<td class="mono">${inv.amount_received_xmr}</td>
<td>${statusBadge(inv.status)}</td>
<td><a href="/portal/invoices/${inv.id}">${inv.description || html`<span class="muted">no description</span>`}</a></td>
</tr>`
)}
</tbody></table>
<div class="pager">
<a class="button" href="/portal/invoices/new">New invoice</a>
${when(page.nextBefore, () => html`<a href="${qs({ before: page.nextBefore! })}">Older &rarr;</a>`)}
</div>`
)}`;
  return layout({ title: "Invoices", body, chrome: "portal", nav: portalNav("invoices") });
}

function newPage(error = "", values: Record<string, string> = {}, csrf = ""): string {
  const v = (k: string) => values[k] ?? "";
  const body = html`<h1>New invoice</h1>
${when(error, () => html`<div class="banner error">${error}</div>`)}
<form method="post" action="/portal/invoices" class="card left">
<input type="hidden" name="_csrf" value="${csrf}">
<label for="amount_xmr">Amount in XMR</label>
<input id="amount_xmr" name="amount_xmr" inputmode="decimal" value="${v("amount_xmr")}">
<p class="hint">Or price it in fiat below. One or the other, not both: the rate is locked when the
invoice is created.</p>
<label for="price_amount">Price</label>
<input id="price_amount" name="price_amount" inputmode="decimal" value="${v("price_amount")}">
<label for="price_currency">Currency</label>
<select id="price_currency" name="price_currency">
<option value="">choose a currency</option>
${SUPPORTED_CURRENCIES.map(
  (c) => html`<option value="${c}" ${v("price_currency") === c ? "selected" : ""}>${c}</option>`
)}
</select>
<label for="description">Description</label>
<input id="description" name="description" maxlength="500" value="${v("description")}">
<p class="hint">Shown to the buyer on the checkout page.</p>
<label for="expires_in_minutes">Expires in (minutes)</label>
<input id="expires_in_minutes" name="expires_in_minutes" type="number" min="5" max="1440" value="${v("expires_in_minutes") || "60"}">
<label for="return_url">Return URL</label>
<input id="return_url" name="return_url" type="url" value="${v("return_url")}">
<p class="hint">Where the buyer goes back to after paying. Optional.</p>
<button type="submit">Create invoice</button>
</form>
<p><a href="/portal/invoices">Back to invoices</a></p>`;
  return layout({ title: "New invoice", body, chrome: "portal", nav: portalNav("invoices") });
}

interface PaymentRow {
  txid: string;
  amount_atomic: string;
  confirmations: number;
  detected_at: string;
  confirmed_at: string | null;
}

interface DeliveryRow {
  id: string;
  event: string;
  attempts: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

function detailPage(
  inv: InvoiceView,
  payments: PaymentRow[],
  deliveries: DeliveryRow[],
  opts: { baseUrl: string; csrf: string; hasWebhookUrl: boolean }
): string {
  const checkout = `${opts.baseUrl}/checkout/${inv.id}`;
  const body = html`<h1>Invoice</h1>
<p class="muted mono">${inv.id}</p>

<div class="card left">
<table>
<tr><th>Status</th><td>${statusBadge(inv.status, inv.confirmations ? ` (${inv.confirmations} conf)` : "")}</td></tr>
<tr><th>Due</th><td>${money(inv)}</td></tr>
<tr><th>Received</th><td class="mono">${inv.amount_received_xmr} XMR</td></tr>
${when(inv.rate, () => html`<tr><th>Locked rate</th><td>${inv.rate} ${inv.price_currency}/XMR</td></tr>`)}
<tr><th>Subaddress</th><td class="mono addr">${inv.subaddress}</td></tr>
<tr><th>Description</th><td>${inv.description || html`<span class="muted">none</span>`}</td></tr>
<tr><th>Created</th><td>${timestamp(inv.created_at)}</td></tr>
<tr><th>Expires</th><td>${timestamp(inv.expires_at)}</td></tr>
<tr><th>Checkout link</th><td><a href="${safeUrl(checkout) ?? "#"}">${checkout}</a></td></tr>
</table>
<p class="hint">The checkout link is a capability: anyone holding it can see this invoice, so
treat it like a secret.</p>
</div>

<h2>Payments</h2>
${when(payments.length === 0, () => html`<p class="muted">Nothing received yet.</p>`)}
${when(
  payments.length > 0,
  () => html`<table>
<thead><tr><th>Transaction</th><th>Amount</th><th>Confirmations</th><th>Seen</th><th>Confirmed</th></tr></thead>
<tbody>${payments.map(
    (p) => html`<tr>
<td class="mono wrap">${p.txid}</td>
<td class="mono">${xmrFromAtomic(BigInt(p.amount_atomic))}</td>
<td>${p.confirmations}</td>
<td>${timestamp(p.detected_at)}</td>
<td>${timestamp(p.confirmed_at)}</td>
</tr>`
  )}</tbody></table>`
)}

<h2>Webhook deliveries</h2>
${when(
  !opts.hasWebhookUrl,
  () => html`<div class="banner info">This account has no webhook URL, so nothing is queued for
delivery. Payments still land and this page still shows them.</div>`
)}
${when(opts.hasWebhookUrl && deliveries.length === 0, () => html`<p class="muted">Nothing queued.</p>`)}
${when(
  deliveries.length > 0,
  () => html`<table>
<thead><tr><th>Event</th><th>Delivered</th><th>Attempts</th><th>Last error</th><th></th></tr></thead>
<tbody>${deliveries.map(
    (d) => html`<tr>
<td>${d.event}</td>
<td>${d.delivered_at ? timestamp(d.delivered_at) : html`<span class="muted">not yet, next ${timestamp(d.next_attempt_at)}</span>`}</td>
<td>${d.attempts}</td>
<td class="wrap">${d.last_error || html`<span class="muted">none</span>`}</td>
<td><form method="post" action="/portal/invoices/${inv.id}/redeliver"><input type="hidden" name="_csrf" value="${opts.csrf}"><input type="hidden" name="delivery_id" value="${d.id}"><button class="secondary" type="submit">Redeliver</button></form></td>
</tr>`
  )}</tbody></table>`
)}
<p><a href="/portal/invoices">Back to invoices</a></p>`;
  return layout({ title: "Invoice", body, chrome: "portal", nav: portalNav("invoices") });
}

export function mountInvoiceRoutes(app: express.Express, opts: InvoiceRoutesOptions): void {
  const session = requireSession();
  const csrf = requireCsrf(opts.baseUrl);
  // Each invoice takes the wallet lock to mint a subaddress, so a
  // double-clicked form must not queue two wallet opens.
  const createLimit = rateLimit({ windowMs: 60_000, max: 20, key: (req) => portal(req).merchant.id });

  app.get("/portal/invoices", session, async (req, res) => {
    try {
      const status = INVOICE_STATUSES.includes(String(req.query.status) as any) ? String(req.query.status) : "";
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
      const before = typeof req.query.before === "string" && UUID_RE.test(req.query.before) ? req.query.before : undefined;
      const page = await listInvoices(query, portal(req).merchant.id, { status, q, before, limit: 25 });
      res.send(listPage(page, { status, q }));
    } catch (e) {
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });

  app.get("/portal/invoices/new", session, (req, res) => {
    res.send(newPage("", {}, portal(req).csrf));
  });

  app.post("/portal/invoices", session, csrf, createLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const keep = {
      amount_xmr: body.amount_xmr ?? "",
      price_amount: body.price_amount ?? "",
      price_currency: body.price_currency ?? "",
      description: body.description ?? "",
      expires_in_minutes: body.expires_in_minutes ?? "",
      return_url: body.return_url ?? "",
    };
    const fail = (message: string, status = 400) =>
      res.status(status).send(newPage(message, keep, portal(req).csrf));

    const fiat = Boolean(body.price_amount?.trim() || body.price_currency);
    const xmr = Boolean(body.amount_xmr?.trim());
    if (fiat && xmr) return fail("Give an amount in XMR or a fiat price, not both.");
    if (!fiat && !xmr) return fail("Give an amount in XMR or a fiat price.");

    try {
      const inv = await createInvoice(portal(req).merchant, {
        amount_xmr: xmr ? body.amount_xmr.trim() : undefined,
        price_amount: fiat ? body.price_amount?.trim() : undefined,
        price_currency: fiat ? body.price_currency : undefined,
        description: body.description?.trim() || undefined,
        expires_in_minutes: body.expires_in_minutes ? Number(body.expires_in_minutes) : undefined,
        return_url: body.return_url?.trim() || undefined,
      });
      res.redirect(303, `/portal/invoices/${inv.id}`);
    } catch (e: any) {
      if (e instanceof InvoiceInputError) return fail(e.message);
      if (e instanceof WalletNotReadyError) return fail(e.message, 503);
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });

  app.get("/portal/invoices/:id", session, async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).send(notFound());
      const p = portal(req);
      const { rows } = await query(`${INVOICE_SELECT} WHERE i.id = $1 AND i.merchant_id = $2 GROUP BY i.id`, [
        req.params.id,
        p.merchant.id,
      ]);
      if (!rows.length) return res.status(404).send(notFound());
      const payments = await query<PaymentRow>(
        `SELECT txid, amount_atomic, confirmations, detected_at, confirmed_at
         FROM payments WHERE invoice_id = $1 ORDER BY detected_at`,
        [req.params.id]
      );
      const deliveries = await query<DeliveryRow>(
        `SELECT id, event, attempts, next_attempt_at, delivered_at, last_error, created_at
         FROM webhook_deliveries WHERE invoice_id = $1 ORDER BY created_at`,
        [req.params.id]
      );
      res.send(
        detailPage(invoiceJson(rows[0]), payments.rows, deliveries.rows, {
          baseUrl: opts.baseUrl,
          csrf: p.csrf,
          hasWebhookUrl: Boolean(p.merchant.webhook_url),
        })
      );
    } catch (e) {
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });

  app.post("/portal/invoices/:id/redeliver", session, csrf, async (req, res) => {
    try {
      const deliveryId = String((req.body as any)?.delivery_id ?? "");
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(deliveryId)) return res.status(404).send(notFound());
      // Scoped to this merchant's own invoice: the delivery id alone is not
      // authority over someone else's row.
      const { rows } = await query(
        `UPDATE webhook_deliveries d SET delivered_at = NULL, attempts = 0, next_attempt_at = now(), last_error = NULL
         FROM invoices i
         WHERE d.id = $1 AND i.id = d.invoice_id AND i.id = $2 AND i.merchant_id = $3
         RETURNING d.id`,
        [deliveryId, req.params.id, portal(req).merchant.id]
      );
      if (!rows.length) return res.status(404).send(notFound());
      res.redirect(303, `/portal/invoices/${req.params.id}`);
    } catch (e) {
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });
}

function notFound(): string {
  return layout({
    title: "Not found",
    body: html`<h1>Not found</h1><p class="muted">No such invoice on this account.</p>
<p><a href="/portal/invoices">Back to invoices</a></p>`,
    chrome: "portal",
    nav: portalNav("invoices"),
  });
}
