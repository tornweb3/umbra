import "dotenv/config";
import express from "express";
import QRCode from "qrcode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "./db.js";
import { encrypt, newSecret, sha256Hex } from "./crypto.js";
import { createViewOnlyWallet, daemonRpc, walletRpcVersion } from "./walletRpc.js";
import { xmrFromAtomic } from "./money.js";
import { escapeHtml, merchant, requireAuth, UUID_RE } from "./http.js";
import { createInvoice, InvoiceInputError } from "./invoices.js";
import { mountShopifyRoutes, shopifyWebhookHandler } from "./shopifyRoutes.js";
import {
  assertSafeWebhookUrl,
  configureProxyTrust,
  rateLimit,
  requireSignupToken,
  serverError,
  UnsafeUrlError,
} from "./security.js";

const app = express();
configureProxyTrust(app);
// Shopify signs the raw request bytes, so its webhook route must see the body
// before express.json() consumes it.
app.post("/shopify/webhooks/:merchantId/:topic", express.raw({ type: "*/*", limit: "1mb" }), shopifyWebhookHandler);
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

// Standard (non-subaddress, non-integrated) address prefixes by network.
// Subaddresses are minted by the wallet itself, so only the merchant's primary
// address is validated here.
const ADDRESS_PREFIX: Record<string, string> = { mainnet: "4", stagenet: "5", testnet: "9" };
const NETWORK = (process.env.MONERO_NETWORK ?? "mainnet").toLowerCase();
const ADDRESS_PREFIX_CHAR = ADDRESS_PREFIX[NETWORK];
if (!ADDRESS_PREFIX_CHAR) {
  throw new Error(`MONERO_NETWORK must be one of: ${Object.keys(ADDRESS_PREFIX).join(", ")}`);
}
// monero-wallet-rpc must be running on this same network, or the keys it is
// handed will not match the addresses it derives.
const ADDRESS_RE = new RegExp(`^${ADDRESS_PREFIX_CHAR}[0-9A-Za-z]{94}$`);
const VIEW_KEY_RE = /^[0-9a-fA-F]{64}$/;

// Buyer-facing routes are polled by checkout pages, so they get room to
// breathe; merchant routes are keyed by account rather than address.
const publicLimit = rateLimit({ windowMs: 60_000, max: 120 });
const merchantLimit = rateLimit({ windowMs: 60_000, max: 60, key: (req) => merchant(req).id });
const signupLimit = rateLimit({ windowMs: 3_600_000, max: 5, message: "too many signup attempts" });

// Liveness and readiness for process managers and compose healthchecks.
// ?deep=1 also pokes the wallet and daemon, which is slower: use it for
// monitoring, not for a restart policy.
app.get("/healthz", publicLimit, async (req, res) => {
  const checks: Record<string, string> = {};
  let healthy = true;
  try {
    await query("SELECT 1");
    checks.database = "ok";
  } catch (e: any) {
    checks.database = `failed: ${e.message}`;
    healthy = false;
  }
  if (req.query.deep) {
    try {
      await walletRpcVersion();
      checks.wallet_rpc = "ok";
    } catch (e: any) {
      checks.wallet_rpc = `failed: ${e.message}`;
      healthy = false;
    }
    try {
      const info = await daemonRpc<{ height: number; synchronized: boolean }>("get_info");
      checks.daemon = info.synchronized ? `ok, height ${info.height}` : `syncing, height ${info.height}`;
      if (!info.synchronized) healthy = false;
    } catch (e: any) {
      checks.daemon = `failed: ${e.message}`;
      healthy = false;
    }
  }
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", network: NETWORK, checks });
});

app.post("/api/merchants", signupLimit, requireSignupToken, async (req, res) => {
  try {
    const { name, address, view_key, webhook_url } = req.body ?? {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
    if (typeof address !== "string" || !ADDRESS_RE.test(address))
      return res.status(400).json({
        error: `address must be a ${NETWORK} standard address (starts with ${ADDRESS_PREFIX_CHAR}, 95 chars)`,
      });
    if (typeof view_key !== "string" || !VIEW_KEY_RE.test(view_key))
      return res.status(400).json({ error: "view_key must be 64 hex chars" });
    if (typeof webhook_url !== "string")
      return res.status(400).json({ error: "webhook_url must be an http(s) URL" });
    try {
      await assertSafeWebhookUrl(webhook_url);
    } catch (e: any) {
      if (e instanceof UnsafeUrlError) return res.status(400).json({ error: e.message });
      throw e;
    }

    // A view-only wallet derives its subaddresses deterministically from the
    // keys, so two merchants sharing an address would mint identical invoice
    // subaddresses and cross-attribute each other's payments. Reject a repeat.
    const dup = await query(`SELECT 1 FROM merchants WHERE address = $1 LIMIT 1`, [address]);
    if (dup.rowCount) return res.status(409).json({ error: "a merchant with this address is already registered" });

    const info = await daemonRpc<{ height: number }>("get_info");
    // Start scanning a little before the current tip so payments sent right
    // around signup are not missed.
    const restoreHeight = Math.max(0, info.height - 100);

    const walletName = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await createViewOnlyWallet(walletName, address, view_key, restoreHeight);

    const secret = newSecret();
    const apiKey = `xmr_sk_${newSecret()}`;
    const { rows } = await query(
      `INSERT INTO merchants (name, address, view_key_enc, wallet_name, api_key_hash, webhook_url, webhook_secret, restore_height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
      [name, address, encrypt(view_key), walletName, sha256Hex(apiKey), webhook_url, secret, restoreHeight]
    );
    res.status(201).json({
      merchant_id: rows[0].id,
      api_key: apiKey,
      webhook_secret: secret,
      note: "Store api_key and webhook_secret now; they are shown only once. Webhook payloads are HMAC-SHA256 signed with webhook_secret (X-Webhook-Signature header).",
    });
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

app.post("/api/invoices", requireAuth, merchantLimit, async (req, res) => {
  try {
    const inv = await createInvoice(merchant(req), req.body ?? {});
    res.status(201).json({
      invoice_id: inv.id,
      subaddress: inv.subaddress,
      amount_atomic: inv.amountAtomic.toString(),
      amount_xmr: xmrFromAtomic(inv.amountAtomic),
      price_amount: inv.fiat?.amount ?? null,
      price_currency: inv.fiat?.currency ?? null,
      rate: inv.fiat?.rate ?? null,
      status: inv.status,
      return_url: inv.return_url,
      metadata: inv.metadata,
      expires_at: inv.expires_at,
      checkout_url: `${BASE_URL}/checkout/${inv.id}`,
    });
  } catch (e: any) {
    if (e instanceof InvoiceInputError) return res.status(400).json({ error: e.message });
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

const INVOICE_SELECT = `
  SELECT i.id, i.merchant_id, i.amount_atomic, i.price_amount, i.price_currency, i.rate,
         i.description, i.subaddress, i.status, i.expires_at, i.created_at, i.return_url, i.metadata,
         COALESCE(SUM(p.amount_atomic), 0)::bigint AS received_atomic,
         COALESCE(MAX(p.confirmations), 0) AS confirmations
  FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id`;

function invoiceJson(row: any) {
  const due = BigInt(row.amount_atomic);
  const received = BigInt(row.received_atomic);
  return {
    id: row.id,
    status: row.status,
    description: row.description,
    subaddress: row.subaddress,
    amount_due_atomic: due.toString(),
    amount_due_xmr: xmrFromAtomic(due),
    amount_received_atomic: received.toString(),
    amount_received_xmr: xmrFromAtomic(received),
    price_amount: row.price_amount,
    price_currency: row.price_currency,
    rate: row.rate,
    confirmations: Number(row.confirmations),
    metadata: row.metadata ?? null,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

// Public: checkout pages poll this. The invoice UUID is the capability.
app.get("/api/invoices/:id", publicLimit, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const { rows } = await query(`${INVOICE_SELECT} WHERE i.id = $1 GROUP BY i.id`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(invoiceJson(rows[0]));
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  const m = merchant(req);
  res.json({ id: m.id, name: m.name, address: m.address, webhook_url: m.webhook_url, created_at: m.created_at });
});

app.get("/api/me/invoices", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `${INVOICE_SELECT} WHERE i.merchant_id = $1 GROUP BY i.id ORDER BY i.created_at DESC`,
      [merchant(req).id]
    );
    res.json(rows.map(invoiceJson));
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

app.get("/api/invoices/:id/webhooks", requireAuth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const { rows } = await query(
      `SELECT d.id, d.event, d.payload, d.attempts, d.next_attempt_at, d.delivered_at, d.last_error, d.created_at
       FROM webhook_deliveries d JOIN invoices i ON i.id = d.invoice_id
       WHERE d.invoice_id = $1 AND i.merchant_id = $2 ORDER BY d.created_at`,
      [req.params.id, merchant(req).id]
    );
    res.json(rows);
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

app.post("/api/webhook-deliveries/:id/redeliver", requireAuth, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const { rows } = await query(
      `UPDATE webhook_deliveries d SET delivered_at = NULL, attempts = 0, next_attempt_at = now(), last_error = NULL
       FROM invoices i
       WHERE d.id = $1 AND i.id = d.invoice_id AND i.merchant_id = $2
       RETURNING d.id`,
      [req.params.id, merchant(req).id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, note: "queued for redelivery" });
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

app.post("/api/me/webhook", requireAuth, async (req, res) => {
  try {
    const { webhook_url } = req.body ?? {};
    if (typeof webhook_url !== "string")
      return res.status(400).json({ error: "webhook_url must be an http(s) URL" });
    try {
      await assertSafeWebhookUrl(webhook_url);
    } catch (e: any) {
      if (e instanceof UnsafeUrlError) return res.status(400).json({ error: e.message });
      throw e;
    }
    await query(`UPDATE merchants SET webhook_url = $1 WHERE id = $2`, [webhook_url, merchant(req).id]);
    res.json({ ok: true, webhook_url });
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

app.post("/api/me/rotate-secret", requireAuth, async (req, res) => {
  try {
    const secret = newSecret();
    await query(`UPDATE merchants SET webhook_secret = $1 WHERE id = $2`, [secret, merchant(req).id]);
    res.json({ webhook_secret: secret, note: "Old secret is invalid immediately. Shown only once." });
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

app.get("/checkout/:id", publicLimit, async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send("Invoice not found");
    const { rows } = await query(`${INVOICE_SELECT} WHERE i.id = $1 GROUP BY i.id`, [req.params.id]);
    if (rows.length === 0) return res.status(404).send("Invoice not found");
    const inv = invoiceJson(rows[0]);
    const amountStr = inv.amount_due_xmr;
    const uri = `monero:${inv.subaddress}?tx_amount=${amountStr}`;
    const qr = await QRCode.toDataURL(uri, { width: 280, margin: 2 });
    const fiatLine =
      inv.price_amount && inv.price_currency
        ? `<p>${escapeHtml(inv.price_amount)} ${escapeHtml(inv.price_currency)} @ ${escapeHtml(Number(inv.rate).toFixed(2))} ${escapeHtml(inv.price_currency)}/XMR</p>`
        : "";
    // Integrations pass a return_url so the buyer can get back to their order.
    const returnUrl: string | null = rows[0].return_url ?? null;
    const returnLine = returnUrl ? `<p><a href="${escapeHtml(returnUrl)}">Return to your order</a></p>` : "";
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay ${escapeHtml(amountStr)} XMR</title>
<style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;text-align:center}
.addr{word-break:break-all;font-family:monospace;font-size:13px;background:#f4f4f4;padding:10px;border-radius:6px}
.status{font-weight:bold;padding:8px 16px;border-radius:6px;display:inline-block;margin-top:12px}
.pending{background:#fff3cd}.detected{background:#cfe2ff}.confirmed{background:#d1e7dd}.expired{background:#f8d7da}
#countdown{color:#666;font-size:14px;margin-top:8px}
</style></head><body>
<h2>Pay ${escapeHtml(amountStr)} XMR</h2>
${fiatLine}
${inv.description ? `<p>${escapeHtml(inv.description)}</p>` : ""}
<img src="${qr}" alt="QR code">
<p class="addr">${escapeHtml(inv.subaddress)}</p>
<p><a href="${escapeHtml(uri)}">Open in wallet</a></p>
<div id="status" class="status ${escapeHtml(inv.status)}">${escapeHtml(inv.status)}</div>
<div id="countdown"></div>
${returnLine}
<script>
const expiresAt = new Date(${JSON.stringify(inv.expires_at)});
function tick(){
  const el = document.getElementById('countdown');
  const st = document.getElementById('status').textContent;
  if(st === 'confirmed' || st.startsWith('expired')){ el.textContent=''; return; }
  const ms = expiresAt - Date.now();
  el.textContent = ms > 0 ? 'Expires in ' + Math.floor(ms/60000) + 'm ' + Math.floor(ms%60000/1000) + 's' : 'Invoice expired';
  setTimeout(tick, 1000);
}
async function poll(){
  const r = await fetch('/api/invoices/' + ${JSON.stringify(inv.id)});
  if(r.ok){const j = await r.json();
    const el = document.getElementById('status');
    el.textContent = j.status + (j.status === 'detected' || j.status === 'confirmed' ? ' (' + j.confirmations + ' conf)' : '');
    el.className = 'status ' + j.status;
    if(j.status === 'confirmed' || j.status === 'expired') return;}
  setTimeout(poll, 10000);
}
tick(); poll();
</script>
</body></html>`);
  } catch (e) {
    serverError(res, e, `${req.method} ${req.path}`);
  }
});

mountShopifyRoutes(app, BASE_URL);

// Loopback by default: in production the gateway belongs behind a reverse
// proxy that terminates TLS. Set BIND_ADDRESS=0.0.0.0 only when something else
// (a container network, a firewall) controls who can reach the port.
const BIND_ADDRESS = process.env.BIND_ADDRESS ?? "127.0.0.1";

const server = app.listen(PORT, BIND_ADDRESS, () => {
  console.log(`gateway server listening on http://${BIND_ADDRESS}:${PORT}`);
});

// Containers and systemd send SIGTERM: stop accepting connections, let the
// in-flight requests finish, then let the pool go.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    // A request wedged on the wallet lock shouldn't hold the process forever.
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
