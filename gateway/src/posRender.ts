// The till's own pages: the app shell, the enrolment page, and a receipt.
//
// The shell holds no merchant data at all, which is why it needs no
// authentication and is identical for every device: the token lives in
// localStorage and everything else arrives from /pos/api/device.
import { layout } from "./ui/layout.js";
import { html, type SafeHtml } from "./ui/html.js";
import { timestamp, when } from "./ui/components.js";
import { xmrFromAtomic } from "./money.js";

const KEYS = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], [".", "0", "back"]];

export function renderTill(): string {
  const body = html`<div class="till">
<div id="offline" class="banner error" hidden>Offline. This till cannot verify a payment right now,
so nothing here is confirmed. The customer's payment still reaches the merchant's wallet either way.</div>

<section id="needs-enrol" hidden>
<h1>This till is not enrolled</h1>
<p class="muted">Open the console, create a device under Point of sale, and scan the code it shows
with this phone.</p>
</section>

<section id="keypad" hidden>
<header class="till-head"><span id="device-label"></span><span class="muted" id="currency"></span></header>
<p class="till-amount"><span id="amount">0</span></p>
<div class="till-keys">
${KEYS.map((row) => html`${row.map((key) => html`<button type="button" data-key="${key}">${key === "back" ? "&larr;" : key}</button>`)}`)}
</div>
<button type="button" class="till-charge" data-action="charge" id="charge-button" disabled>Charge</button>
<p class="hint" id="zeroconf-note"></p>
</section>

<section id="charge" hidden>
<p class="till-amount" id="charge-amount"></p>
<p class="muted" id="charge-xmr"></p>
<img id="charge-qr" alt="Payment QR code" width="260" height="260" hidden>
<div id="charge-status" class="status pending"></div>
<p class="muted" id="charge-received"></p>

<div id="shortfall" hidden>
<div class="banner warn">Short by <span id="short-amount"></span> XMR.</div>
<button type="button" class="secondary" data-action="remainder">Charge the difference</button>
<button type="button" class="secondary" data-action="accept">Accept as paid</button>
</div>

<div id="open-actions">
<p><a id="customer-link" target="_blank" rel="noopener">Show the customer</a></p>
<button type="button" class="secondary" data-action="cancel">Cancel</button>
</div>

<div id="settled-actions" hidden>
<p><a id="receipt-link" target="_blank" rel="noopener">Receipt</a></p>
<button type="button" data-action="new">New sale</button>
</div>
</section>
</div>`;
  return layout({ title: "Till", body, chrome: "minimal", scripts: ["pos.js"] });
}

export function renderEnrol(): string {
  const body = html`<h1>Enrolling this till</h1>
<p id="enrol-status" class="muted">Working...</p>
<p class="hint">The code is used once and never stored on this device. What is stored is a
credential that only this till can use, and that the merchant can revoke on its own without
touching anything else.</p>`;
  return layout({ title: "Enrol a till", body, chrome: "minimal", scripts: ["pos-enrol.js"] });
}

export interface ReceiptData {
  id: string;
  created_at: string;
  status: string;
  amount_atomic: string;
  received_atomic: string;
  tip_atomic: string;
  price_amount: string | null;
  price_currency: string | null;
  accepted_at: string | null;
  device_label: string | null;
  merchant_name: string;
  txids: string[];
}

export function renderReceipt(r: ReceiptData, checkoutUrl: string, qr: string): string {
  const total = BigInt(r.amount_atomic);
  const tip = BigInt(r.tip_atomic);
  const body = html`<div class="receipt">
<h1>${r.merchant_name}</h1>
<p class="muted">${timestamp(r.created_at)}${when(r.device_label, () => html` &middot; ${r.device_label}`)}</p>

<table>
${when(
  r.price_amount && r.price_currency,
  () => html`<tr><th>Price</th><td>${r.price_amount} ${r.price_currency}</td></tr>`
)}
${when(tip > 0n, () => html`<tr><th>Of which tip</th><td>${xmrFromAtomic(tip)} XMR</td></tr>`)}
<tr><th>Total</th><td>${xmrFromAtomic(total)} XMR</td></tr>
<tr><th>Received</th><td>${xmrFromAtomic(BigInt(r.received_atomic))} XMR</td></tr>
<tr><th>Status</th><td>${r.accepted_at ? "accepted by the merchant" : r.status}</td></tr>
</table>

${when(
  r.txids.length > 0,
  () => html`<h2>Transactions</h2>
<ul class="receipt-tx">${r.txids.map((t) => html`<li class="mono wrap">${t}</li>`)}</ul>`
)}

<img src="${qr}" alt="Link to this payment" width="160" height="160">
<p class="hint mono wrap">${checkoutUrl}</p>
<p class="hint">Keep this link: it is the only proof of this payment that does not depend on the
merchant's own records.</p>
</div>`;
  return layout({ title: "Receipt", body, chrome: "minimal" });
}

export function renderPosMessage(title: string, message: string): string {
  const body: SafeHtml = html`<h1>${title}</h1><p class="muted">${message}</p>`;
  return layout({ title, body, chrome: "minimal" });
}
