// The buyer-facing checkout page. The most-seen surface in the product, and
// the one where an injected script would be a stolen payment, so it renders
// through the escaping template and keeps its script in a static asset.
import type express from "express";
import QRCode from "qrcode";
import { query } from "./db.js";
import { UUID_RE } from "./http.js";
import { INVOICE_SELECT, invoiceJson } from "./invoiceQueries.js";
import { serverError } from "./security.js";
import { statusBadge, when } from "./ui/components.js";
import { html, safeUrl } from "./ui/html.js";
import { layout } from "./ui/layout.js";

export function mountCheckoutRoutes(app: express.Express, limit: express.RequestHandler): void {
  app.get("/checkout/:id", limit, async (req, res) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(404).send("Invoice not found");
      const { rows } = await query(`${INVOICE_SELECT} WHERE i.id = $1 GROUP BY i.id`, [req.params.id]);
      if (rows.length === 0) return res.status(404).send("Invoice not found");

      const inv = invoiceJson(rows[0]);
      const amount = inv.amount_due_xmr;
      const uri = `monero:${inv.subaddress}?tx_amount=${amount}`;
      // The subaddress comes out of the database, so the URI is validated like
      // any other: a wallet link is the one place a buyer will actually click.
      const walletUri = safeUrl(uri, ["monero:"]);
      const qr = await QRCode.toDataURL(uri, { width: 280, margin: 2 });
      // Integrations pass a return_url so the buyer can get back to their order.
      const back = safeUrl(rows[0].return_url);

      const body = html`<div id="invoice" data-invoice-id="${inv.id}" data-expires-at="${inv.expires_at}" data-status="${inv.status}">
<h2>Pay ${amount} XMR</h2>
${when(
  inv.price_amount && inv.price_currency,
  () => html`<p>${inv.price_amount} ${inv.price_currency} @ ${Number(inv.rate).toFixed(2)} ${inv.price_currency}/XMR</p>`
)}
${when(inv.description, () => html`<p>${inv.description}</p>`)}
<img src="${qr}" alt="QR code" width="280" height="280">
<p class="addr">${inv.subaddress}</p>
${when(walletUri, () => html`<p><a href="${walletUri}">Open in wallet</a></p>`)}
${statusBadge(inv.status)}
<div id="countdown"></div>
${when(back, () => html`<p><a href="${back}">Return to your order</a></p>`)}
</div>`;

      res.send(layout({ title: `Pay ${amount} XMR`, body, scripts: ["checkout.js"] }));
    } catch (e) {
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });
}
