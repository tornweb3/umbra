// The Express app, built by a function so tests can mount it without binding a
// port. Process concerns (dotenv, listen, signals) live in server.ts.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./db.js";
import { newSecret } from "./crypto.js";
import { daemonRpc, walletRpcVersion } from "./walletRpc.js";
import { xmrFromAtomic } from "./money.js";
import { merchant, requireAuth, UUID_RE } from "./http.js";
import { createInvoice, InvoiceInputError, WalletNotReadyError } from "./invoices.js";
import { createMerchant } from "./merchants.js";
import { INVOICE_SELECT, invoiceJson } from "./invoiceQueries.js";
import { mountCheckoutRoutes } from "./checkout.js";
import { mountPortalRoutes } from "./portal/index.js";
import { securityHeaders } from "./headers.js";
import { mountAssetRoutes } from "./ui/layout.js";
import { mountShopifyRoutes, shopifyWebhookHandler } from "./shopifyRoutes.js";
import {
  assertSafeWebhookUrl,
  configureProxyTrust,
  rateLimit,
  requireSignupToken,
  serverError,
  UnsafeUrlError,
} from "./security.js";

// Standard (non-subaddress, non-integrated) address prefixes by network.
// Subaddresses are minted by the wallet itself, so only the merchant's primary
// address is validated here.
const ADDRESS_PREFIX: Record<string, string> = { mainnet: "4", stagenet: "5", testnet: "9" };
const VIEW_KEY_RE = /^[0-9a-fA-F]{64}$/;

export interface AppOptions {
  /** Externally reachable base URL. Checkout and pay links are built from it. */
  baseUrl: string;
  /** mainnet | stagenet | testnet. Decides which address prefix signup accepts. */
  network: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ baseUrl, network }: AppOptions): express.Express {
  const NETWORK = network.toLowerCase();
  const ADDRESS_PREFIX_CHAR = ADDRESS_PREFIX[NETWORK];
  if (!ADDRESS_PREFIX_CHAR) {
    throw new Error(`MONERO_NETWORK must be one of: ${Object.keys(ADDRESS_PREFIX).join(", ")}`);
  }
  // monero-wallet-rpc must be running on this same network, or the keys it is
  // handed will not match the addresses it derives.
  const ADDRESS_RE = new RegExp(`^${ADDRESS_PREFIX_CHAR}[0-9A-Za-z]{94}$`);

  const app = express();
  configureProxyTrust(app);
  app.use(securityHeaders());
  // Shopify signs the raw request bytes, so its webhook route must see the body
  // before express.json() consumes it.
  app.post("/shopify/webhooks/:merchantId/:topic", express.raw({ type: "*/*", limit: "1mb" }), shopifyWebhookHandler);
  app.use(express.json());
  // Browser forms post urlencoded bodies. Kept small: nothing legitimate here
  // is large, and the parser runs before any authentication.
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  mountAssetRoutes(app);
  // index: false so a file in public/ can never shadow GET / below.
  app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

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
      // Optional: a merchant using only the hosted checkout page has nowhere
      // to deliver to, and the SSRF guard refuses the private URL they would
      // otherwise invent.
      let webhookUrl: string | null = null;
      if (webhook_url !== undefined && webhook_url !== null && webhook_url !== "") {
        if (typeof webhook_url !== "string")
          return res.status(400).json({ error: "webhook_url must be an http(s) URL" });
        try {
          await assertSafeWebhookUrl(webhook_url);
        } catch (e: any) {
          if (e instanceof UnsafeUrlError) return res.status(400).json({ error: e.message });
          throw e;
        }
        webhookUrl = webhook_url;
      }

      // A view-only wallet derives its subaddresses deterministically from the
      // keys, so two merchants sharing an address would mint identical invoice
      // subaddresses and cross-attribute each other's payments. Reject a repeat.
      const dup = await query(`SELECT 1 FROM merchants WHERE address = $1 LIMIT 1`, [address]);
      if (dup.rowCount) return res.status(409).json({ error: "a merchant with this address is already registered" });

      // Returns as soon as the row is written. The worker builds the wallet,
      // which takes minutes and would otherwise time out this request and
      // destroy the only copy of the API key with it.
      const created = await createMerchant({ name, address, view_key, webhook_url: webhookUrl });
      res.status(201).json({
        merchant_id: created.id,
        api_key: created.apiKey,
        webhook_secret: created.webhookSecret,
        wallet_status: "provisioning",
        note: "Store api_key and webhook_secret now; they are shown only once. Your view-only wallet is being prepared in the background: invoice creation returns 503 until it is ready, which usually takes a few minutes. Webhook payloads are HMAC-SHA256 signed with webhook_secret (X-Webhook-Signature header).",
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
        checkout_url: `${baseUrl}/checkout/${inv.id}`,
      });
    } catch (e: any) {
      if (e instanceof InvoiceInputError) return res.status(400).json({ error: e.message });
      if (e instanceof WalletNotReadyError) {
        res.setHeader("Retry-After", "60");
        return res.status(503).json({ error: e.message });
      }
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });

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

  mountCheckoutRoutes(app, publicLimit);

  mountShopifyRoutes(app, baseUrl);
  mountPortalRoutes(app, { baseUrl, network: NETWORK });

  // The front door. A gateway with no account sends you to setup, which is
  // what makes it usable without a terminal.
  app.get("/", (_req, res) => res.redirect(302, "/portal"));

  return app;
}
