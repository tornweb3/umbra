// HTTP surface of the Shopify bridge: merchant connect/status/disconnect, the
// signed webhook receiver, and the buyer-facing pay links.
import type express from "express";
import { query } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { merchant, requireAuth, UUID_RE } from "./http.js";
import { when } from "./ui/components.js";
import { html, safeUrl, SafeHtml } from "./ui/html.js";
import { layout } from "./ui/layout.js";
import { orderLookupLimit, payLinkLimit } from "./limits.js";
import { serverError } from "./security.js";
import {
  adminGraphql,
  cancelOrder,
  DEFAULT_METHOD_NAME,
  enqueueOrder,
  ensureInvoice,
  isMoneroOrder,
  loadStoreByMerchant,
  loadStoreByShop,
  orderGid,
  registerWebhooks,
  requestAccessToken,
  SHOP_DOMAIN_RE,
  syncStore,
  verifyShopifyHmac,
  WEBHOOK_TOPICS,
  type EnsureResult,
  type ShopifyStore,
} from "./shopify.js";

const CAN_REGISTER_WEBHOOKS = (baseUrl: string) =>
  baseUrl.startsWith("https://") || Boolean(process.env.SHOPIFY_TEST_API_BASE);

// Registered before express.json() (see server.ts) so req.body is the raw Buffer.
export async function shopifyWebhookHandler(req: express.Request, res: express.Response): Promise<void> {
  try {
    const { merchantId, topic } = req.params;
    if (!UUID_RE.test(merchantId) || !Object.hasOwn(WEBHOOK_TOPICS, topic)) {
      res.status(404).end();
      return;
    }
    // Unknown store (disconnected): a non-2xx makes Shopify drop the
    // subscription after its retries, which is what we want.
    const store = await loadStoreByMerchant(merchantId);
    if (!store || !Buffer.isBuffer(req.body)) {
      res.status(404).end();
      return;
    }
    if (!verifyShopifyHmac(decrypt(store.client_secret_enc), req.body, req.get("X-Shopify-Hmac-SHA256"))) {
      res.status(401).end();
      return;
    }
    const payload = JSON.parse(req.body.toString("utf8"));
    const gid: string | null = payload.admin_graphql_api_id ?? (payload.id ? orderGid(payload.id) : null);
    // Shopify allows 5s for the whole request, and minting an invoice waits on
    // the wallet lock, so only enqueue here; the worker does the rest. Both
    // writes are idempotent, which also absorbs Shopify's redeliveries.
    // The payload names the payment method, so card orders are dropped here
    // instead of costing an Admin API read each; if the field is ever absent
    // we enqueue and let the worker decide.
    const gateways = payload.payment_gateway_names;
    const notOurs = Array.isArray(gateways) && !isMoneroOrder(store, gateways);
    if (gid && topic === "orders-cancelled") await cancelOrder(store.merchant_id, gid);
    else if (gid && !notOurs) await enqueueOrder(store.merchant_id, gid, { number: payload.order_number, name: payload.name });
    res.status(200).end();
  } catch (e: any) {
    console.error(`shopify webhook failed: ${e.message}`);
    res.status(500).end();
  }
}

const page = (title: string, body: SafeHtml): string => layout({ title, body });

function sendResult(res: express.Response, store: ShopifyStore, r: EnsureResult): void {
  if (r.kind === "invoice") {
    res.redirect(302, `/checkout/${r.invoiceId}`);
    return;
  }
  // status_page_url arrives from the Shopify Admin API. Escaping it makes it
  // safe as text and says nothing about its scheme, so it is validated too.
  const back = safeUrl(r.row?.status_page_url);
  const status = r.kind === "not_found" ? 404 : r.kind === "error" ? 502 : 200;
  res.status(status).send(
    page(
      store.shop_domain,
      html`<h2>${r.row?.order_name ?? "Your order"}</h2><p>${r.message}</p>${when(
        back,
        () => html`<p><a href="${back}">View your order</a></p>`
      )}`
    )
  );
}

export function mountShopifyRoutes(app: express.Express, baseUrl: string): void {
  // Connect (or reconnect) the merchant's store. Validates the credentials by
  // minting a token, then registers webhooks when we have a public HTTPS URL.
  app.put("/api/me/shopify", requireAuth, async (req, res) => {
    try {
      const m = merchant(req);
      const { shop_domain, client_id, client_secret, payment_method_name } = req.body ?? {};
      const shop = typeof shop_domain === "string" ? shop_domain.trim().toLowerCase() : "";
      if (!SHOP_DOMAIN_RE.test(shop))
        return res.status(400).json({ error: "shop_domain must be your <store>.myshopify.com domain" });
      if (typeof client_id !== "string" || !client_id.trim() || client_id.length > 200)
        return res.status(400).json({ error: "client_id required (Dev Dashboard → your app → Settings)" });
      if (typeof client_secret !== "string" || !client_secret.trim() || client_secret.length > 200)
        return res.status(400).json({ error: "client_secret required (Dev Dashboard → your app → Settings)" });
      const methodName =
        payment_method_name === undefined ? DEFAULT_METHOD_NAME : String(payment_method_name).trim();
      if (!methodName || methodName.length > 100)
        return res.status(400).json({ error: "payment_method_name must be 1-100 characters" });

      const taken = await query(`SELECT 1 FROM shopify_stores WHERE shop_domain = $1 AND merchant_id <> $2`, [shop, m.id]);
      if (taken.rowCount) return res.status(409).json({ error: "this store is connected to another Umbra account" });

      let token;
      try {
        token = await requestAccessToken(shop, client_id.trim(), client_secret.trim());
      } catch (e: any) {
        return res.status(400).json({
          error: `Shopify rejected these credentials. Check the client ID and secret, and that the app is installed on ${shop}. (${e.message})`,
        });
      }
      // write_orders implies read access and is what orderMarkAsPaid needs.
      if (token.scope !== null && !token.scope.split(",").map((s) => s.trim()).includes("write_orders"))
        return res.status(400).json({
          error: `The app is missing the write_orders scope (granted: ${token.scope || "none"}). Add read_orders and write_orders to a new app version, release it, and approve it on the store.`,
        });

      await query(
        `INSERT INTO shopify_stores (merchant_id, shop_domain, client_id, client_secret_enc, access_token_enc, token_expires_at, payment_method_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (merchant_id) DO UPDATE SET
           shop_domain = EXCLUDED.shop_domain, client_id = EXCLUDED.client_id,
           client_secret_enc = EXCLUDED.client_secret_enc, access_token_enc = EXCLUDED.access_token_enc,
           token_expires_at = EXCLUDED.token_expires_at, payment_method_name = EXCLUDED.payment_method_name,
           webhooks_registered_at = NULL, last_synced_at = NULL, last_error = NULL`,
        [m.id, shop, client_id.trim(), encrypt(client_secret.trim()), encrypt(token.token), token.expiresAt, methodName]
      );
      const store = (await loadStoreByMerchant(m.id))!;

      let shopName: string | null = null;
      let webhooks: string;
      try {
        shopName = (await adminGraphql<{ shop: { name: string } }>(store, `query { shop { name } }`)).shop.name;
      } catch {
        /* name is cosmetic */
      }
      if (CAN_REGISTER_WEBHOOKS(baseUrl)) {
        try {
          await registerWebhooks(store, baseUrl);
          webhooks = "registered";
        } catch (e: any) {
          webhooks = `failed: ${e.message} (orders are still picked up by polling)`;
        }
      } else {
        webhooks = "skipped: PUBLIC_BASE_URL is not https, so orders are picked up by polling only";
      }
      res.json({ ok: true, shop_domain: shop, shop_name: shopName, payment_method_name: methodName, webhooks, ...setupHints(baseUrl, shop, methodName) });
    } catch (e) {
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });

  app.get("/api/me/shopify", requireAuth, async (req, res) => {
    try {
      const m = merchant(req);
      const { rows } = await query(
        `SELECT shop_domain, payment_method_name, webhooks_registered_at, last_synced_at, last_error, created_at
         FROM shopify_stores WHERE merchant_id = $1`,
        [m.id]
      );
      if (!rows.length) return res.json({ connected: false });
      const s = rows[0];
      const orders = await query(
        `SELECT so.order_name, so.order_number, so.state, so.invoice_id, i.status AS invoice_status,
                i.price_amount, i.price_currency, so.last_error, so.paid_marked_at, so.created_at
         FROM shopify_orders so LEFT JOIN invoices i ON i.id = so.invoice_id
         WHERE so.merchant_id = $1 ORDER BY so.created_at DESC LIMIT 25`,
        [m.id]
      );
      res.json({ connected: true, ...s, ...setupHints(baseUrl, s.shop_domain, s.payment_method_name), recent_orders: orders.rows });
    } catch (e) {
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });

  // Disconnecting stops processing immediately; the orphaned webhook
  // subscriptions then fail (404) and Shopify removes them itself.
  app.delete("/api/me/shopify", requireAuth, async (req, res) => {
    try {
      const { rowCount } = await query(`DELETE FROM shopify_stores WHERE merchant_id = $1`, [merchant(req).id]);
      res.json({ ok: true, disconnected: Boolean(rowCount) });
    } catch (e) {
      serverError(res, e, `${req.method} ${req.path}`);
    }
  });

  // Buyer pay link from the order confirmation email. The order id is
  // Shopify's system-wide id, not the store's short sequential number.
  app.get("/shopify/pay/:shop/:orderId", payLinkLimit, async (req, res) => {
    try {
      const shop = req.params.shop.toLowerCase();
      const store = SHOP_DOMAIN_RE.test(shop) ? await loadStoreByShop(shop) : null;
      if (!store || !/^\d{1,20}$/.test(req.params.orderId))
        return res.status(404).send(page("Not found", html`<h2>Order not found</h2>`));
      sendResult(res, store, await ensureInvoice(store, orderGid(req.params.orderId)));
    } catch (e: any) {
      console.error(`shopify pay link failed: ${e.message}`);
      res.status(502).send(page("Try again", html`<h2>We couldn't prepare your payment</h2><p>Please try again in a minute.</p>`));
    }
  });

  // Fallback for buyers without the email: look an order up by its number.
  app.get("/shopify/pay/:shop", orderLookupLimit, async (req, res) => {
    try {
      const shop = req.params.shop.toLowerCase();
      const store = SHOP_DOMAIN_RE.test(shop) ? await loadStoreByShop(shop) : null;
      if (!store) return res.status(404).send(page("Not found", html`<h2>Store not found</h2>`));
      const form = (msg = "") =>
        page(
          `Pay with Monero · ${store.shop_domain}`,
          html`<h2>Pay with Monero</h2><p>Enter the order number from your confirmation page.</p>
${when(msg, () => html`<p class="err">${msg}</p>`)}
<form method="get"><label for="order">Order number</label><input id="order" name="order" inputmode="numeric" placeholder="#1001" autofocus required><button>Continue</button></form>`
        );
      const raw = typeof req.query.order === "string" ? req.query.order : "";
      if (!raw) return res.send(form());
      const number = raw.replace(/\D/g, "");
      if (!number || number.length > 15) return res.send(form("That doesn't look like an order number."));

      const find = async () =>
        (
          await query<{ order_gid: string }>(
            `SELECT order_gid FROM shopify_orders
             WHERE merchant_id = $1 AND order_number = $2 AND created_at > now() - interval '14 days'`,
            [store.merchant_id, number]
          )
        ).rows[0];
      let hit = await find();
      if (!hit) {
        // The webhook may not have landed yet; poll the store once and retry.
        await syncStore(store).catch(() => {});
        hit = await find();
      }
      if (!hit) return res.send(form(`We couldn't find an unpaid ${store.payment_method_name} order with that number.`));
      sendResult(res, store, await ensureInvoice(store, hit.order_gid));
    } catch (e: any) {
      console.error(`shopify pay lookup failed: ${e.message}`);
      res.status(502).send(page("Try again", html`<h2>We couldn't prepare your payment</h2><p>Please try again in a minute.</p>`));
    }
  });
}

// What the merchant pastes into Shopify: the manual payment method's
// instructions and the pay button for the order confirmation email template.
function setupHints(baseUrl: string, shop: string, methodName: string) {
  const lookup = `${baseUrl}/shopify/pay/${shop}`;
  return {
    pay_lookup_url: lookup,
    payment_instructions: `Complete your payment in Monero: we've emailed you a secure payment link. You can also pay at ${lookup} with your order number.`,
    email_snippet:
      `{% if financial_status == "pending" %}\n` +
      `  <p><a href="${lookup}/{{ id }}">Pay with Monero</a></p>\n` +
      `{% endif %}`,
    payment_method_name_hint: `Create a manual payment method named exactly "${methodName}".`,
  };
}
