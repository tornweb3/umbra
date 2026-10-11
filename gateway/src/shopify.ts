// Shopify bridge. The merchant creates their own app in Shopify's Dev
// Dashboard, installs it on their store, and hands us its client ID and
// secret; because app and store share an organization, the client credentials
// grant yields 24h Admin API tokens with no OAuth flow. Buyers choose the
// store's "Pay with Monero" manual payment method, which leaves the order
// pending; each such order gets an Umbra invoice, and when that invoice
// confirms we mark the order paid through the Admin API.
//
// Orders arrive two ways: an orders/create webhook (fast) and a periodic poll
// of recent pending orders (the safety net, since Shopify deletes API-created
// webhook subscriptions after 8 failed deliveries). Both only enqueue a row;
// the worker and the buyer pay link do the Shopify reads and invoice minting.
import { createHmac, timingSafeEqual } from "node:crypto";
import { pool, query } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { createInvoice } from "./invoices.js";
import { isSupportedCurrency } from "./rates.js";

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-07";
export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const DEFAULT_METHOD_NAME = "Pay with Monero";

// Test hook: send every Shopify call to a local mock (tools/shopify-mock.mjs)
// instead of https://<shop>. Never set this in production.
const TEST_API_BASE = process.env.SHOPIFY_TEST_API_BASE ?? "";
if (TEST_API_BASE) console.warn(`shopify: SHOPIFY_TEST_API_BASE set, Admin API calls go to ${TEST_API_BASE}`);

const INVOICE_EXPIRY_MIN = Number(process.env.SHOPIFY_INVOICE_EXPIRY_MIN ?? 60);
const SYNC_INTERVAL_MS = Number(process.env.SHOPIFY_SYNC_INTERVAL_MS ?? 120_000);
const MAX_ATTEMPTS = 8;
// Advisory-lock namespace for per-order serialization (two-key form, so it
// can't collide with the wallet lock's single-key space).
const ORDER_LOCK_CLASS = 4242;

export interface ShopifyStore {
  merchant_id: string;
  wallet_name: string;
  wallet_ready_at: string | null;
  shop_domain: string;
  client_id: string;
  client_secret_enc: Buffer;
  access_token_enc: Buffer | null;
  token_expires_at: Date | null;
  payment_method_name: string;
}

export interface ShopifyOrderRow {
  id: string;
  merchant_id: string;
  order_gid: string;
  order_id: string;
  order_number: string | null;
  order_name: string | null;
  status_page_url: string | null;
  invoice_id: string | null;
  state: "new" | "invoiced" | "paid" | "cancelled" | "ignored" | "error";
  last_error: string | null;
}

const STORE_SELECT = `
  SELECT s.merchant_id, m.wallet_name, m.wallet_ready_at, s.shop_domain, s.client_id, s.client_secret_enc,
         s.access_token_enc, s.token_expires_at, s.payment_method_name
  FROM shopify_stores s JOIN merchants m ON m.id = s.merchant_id`;

export async function loadStoreByMerchant(merchantId: string): Promise<ShopifyStore | null> {
  const { rows } = await query<ShopifyStore>(`${STORE_SELECT} WHERE s.merchant_id = $1`, [merchantId]);
  return rows[0] ?? null;
}

export async function loadStoreByShop(shopDomain: string): Promise<ShopifyStore | null> {
  const { rows } = await query<ShopifyStore>(`${STORE_SELECT} WHERE s.shop_domain = $1`, [shopDomain]);
  return rows[0] ?? null;
}

export function orderGid(orderId: string | number): string {
  return `gid://shopify/Order/${orderId}`;
}

function orderIdFromGid(gid: string): string {
  const id = gid.split("/").pop() ?? "";
  if (!/^\d{1,20}$/.test(id)) throw new Error(`unexpected Shopify order id: ${gid}`);
  return id;
}

function adminBase(shop: string): string {
  return TEST_API_BASE || `https://${shop}`;
}

// ---- Admin API access ------------------------------------------------------

export async function requestAccessToken(
  shop: string,
  clientId: string,
  clientSecret: string
): Promise<{ token: string; scope: string | null; expiresAt: Date }> {
  const res = await fetch(`${adminBase(shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof json.access_token !== "string") {
    const detail = json.error_description ?? json.error ?? json.errors;
    throw new Error(`Shopify token request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const ttlSec = Number(json.expires_in ?? 86_399);
  return {
    token: json.access_token,
    scope: typeof json.scope === "string" ? json.scope : null,
    expiresAt: new Date(Date.now() + ttlSec * 1000),
  };
}

async function accessToken(store: ShopifyStore): Promise<string> {
  const exp = store.token_expires_at ? new Date(store.token_expires_at).getTime() : 0;
  if (store.access_token_enc && exp - Date.now() > 5 * 60_000) return decrypt(store.access_token_enc);
  const { token, expiresAt } = await requestAccessToken(
    store.shop_domain,
    store.client_id,
    decrypt(store.client_secret_enc)
  );
  const enc = encrypt(token);
  await query(`UPDATE shopify_stores SET access_token_enc = $1, token_expires_at = $2 WHERE merchant_id = $3`, [
    enc,
    expiresAt,
    store.merchant_id,
  ]);
  store.access_token_enc = enc;
  store.token_expires_at = expiresAt;
  return token;
}

export async function adminGraphql<T = any>(
  store: ShopifyStore,
  gql: string,
  variables: Record<string, unknown> = {},
  retried = false
): Promise<T> {
  const token = await accessToken(store);
  const res = await fetch(`${adminBase(store.shop_domain)}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: gql, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 && !retried) {
    // Token revoked or expired early (e.g. app reinstalled): fetch a fresh one once.
    await query(`UPDATE shopify_stores SET access_token_enc = NULL, token_expires_at = NULL WHERE merchant_id = $1`, [
      store.merchant_id,
    ]);
    store.access_token_enc = null;
    store.token_expires_at = null;
    return adminGraphql<T>(store, gql, variables, true);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`Shopify Admin API HTTP ${res.status}`);
  if (json.errors) {
    const msg = Array.isArray(json.errors) ? json.errors.map((e: any) => e.message).join("; ") : String(json.errors);
    throw new Error(`Shopify Admin API: ${msg}`);
  }
  return json.data as T;
}

function userErrorText(errors: { message: string }[] | undefined): string | null {
  return errors && errors.length ? errors.map((e) => e.message).join("; ") : null;
}

// ---- Webhooks --------------------------------------------------------------

// Shopify signs the raw body: base64(HMAC-SHA256(client secret, body)).
export function verifyShopifyHmac(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("base64"));
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export const WEBHOOK_TOPICS = { "orders-create": "ORDERS_CREATE", "orders-cancelled": "ORDERS_CANCELLED" } as const;

export async function registerWebhooks(store: ShopifyStore, baseUrl: string): Promise<void> {
  for (const [path, topic] of Object.entries(WEBHOOK_TOPICS)) {
    const data = await adminGraphql(
      store,
      `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          webhookSubscription { id }
          userErrors { field message }
        }
      }`,
      { topic, webhookSubscription: { uri: `${baseUrl}/shopify/webhooks/${store.merchant_id}/${path}` } }
    );
    const err = userErrorText(data.webhookSubscriptionCreate.userErrors);
    // Reconnecting re-registers the same address; Shopify reports that as taken.
    if (err && !/already been taken/i.test(err)) throw new Error(`registering ${topic} webhook: ${err}`);
  }
  await query(`UPDATE shopify_stores SET webhooks_registered_at = now() WHERE merchant_id = $1`, [store.merchant_id]);
}

// ---- Order queue -----------------------------------------------------------

export async function enqueueOrder(
  merchantId: string,
  gid: string,
  known: { number?: string | number | null; name?: string | null } = {}
): Promise<void> {
  await query(
    `INSERT INTO shopify_orders (merchant_id, order_gid, order_id, order_number, order_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (merchant_id, order_gid) DO UPDATE SET
       order_number = COALESCE(shopify_orders.order_number, EXCLUDED.order_number),
       order_name = COALESCE(shopify_orders.order_name, EXCLUDED.order_name)`,
    [merchantId, gid, orderIdFromGid(gid), known.number ?? null, known.name ?? null]
  );
}

// A cancelled order stops being payable: withdraw its unpaid invoice so the
// worker stops watching it. Money already in flight (detected) is left for
// the merchant to refund from their own wallet.
export async function cancelOrder(merchantId: string, gid: string): Promise<void> {
  const { rows } = await query<{ invoice_id: string | null }>(
    `INSERT INTO shopify_orders (merchant_id, order_gid, order_id, state)
     VALUES ($1, $2, $3, 'cancelled')
     ON CONFLICT (merchant_id, order_gid) DO UPDATE SET state = 'cancelled'
       WHERE shopify_orders.state <> 'paid'
     RETURNING invoice_id`,
    [merchantId, gid, orderIdFromGid(gid)]
  );
  const invoiceId = rows[0]?.invoice_id;
  if (invoiceId) {
    await query(`UPDATE invoices SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [invoiceId]);
  }
}

interface ShopifyOrder {
  id: string;
  name: string;
  number: number;
  paymentGatewayNames: string[];
  displayFinancialStatus: string | null;
  cancelledAt: string | null;
  statusPageUrl: string;
  totalOutstandingSet: { presentmentMoney: { amount: string; currencyCode: string } };
}

async function fetchOrder(store: ShopifyStore, gid: string): Promise<ShopifyOrder | null> {
  const data = await adminGraphql<{ order: ShopifyOrder | null }>(
    store,
    `query order($id: ID!) {
      order(id: $id) {
        id name number paymentGatewayNames displayFinancialStatus cancelledAt statusPageUrl
        totalOutstandingSet { presentmentMoney { amount currencyCode } }
      }
    }`,
    { id: gid }
  );
  return data.order;
}

export function isMoneroOrder(store: ShopifyStore, gateways: string[]): boolean {
  const want = store.payment_method_name.trim().toLowerCase();
  return gateways.some((g) => g.trim().toLowerCase() === want);
}

export type EnsureResult =
  | { kind: "invoice"; invoiceId: string; row: ShopifyOrderRow }
  | { kind: "paid" | "cancelled" | "ignored" | "partial" | "not_found" | "error"; message: string; row?: ShopifyOrderRow };

// Makes sure a payable order has a live invoice, minting one (or re-quoting an
// expired one) if needed. Serialized per order with an advisory lock so the
// worker and a buyer opening the pay link at the same moment can't mint two.
export async function ensureInvoice(store: ShopifyStore, gid: string): Promise<EnsureResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ORDER_LOCK_CLASS, `${store.merchant_id}:${gid}`]);
    const result = await ensureInvoiceLocked(store, gid, client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function ensureInvoiceLocked(store: ShopifyStore, gid: string, client: import("pg").PoolClient): Promise<EnsureResult> {
  const read = async () =>
    (
      await client.query<ShopifyOrderRow>(`SELECT * FROM shopify_orders WHERE merchant_id = $1 AND order_gid = $2`, [
        store.merchant_id,
        gid,
      ])
    ).rows[0] ?? null;

  let row = await read();
  if (row?.state === "paid") return { kind: "paid", message: "This order is already paid.", row };
  if (row?.state === "cancelled") return { kind: "cancelled", message: "This order was cancelled.", row };
  if (row?.state === "ignored") return { kind: "ignored", message: `This order wasn't placed with ${store.payment_method_name}.`, row };

  // Fast path: a live invoice already exists, no Shopify call needed.
  if (row?.invoice_id) {
    const inv = (
      await client.query<{ status: string; received: string }>(
        `SELECT i.status, COALESCE(SUM(p.amount_atomic), 0)::bigint AS received
         FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id WHERE i.id = $1 GROUP BY i.id`,
        [row.invoice_id]
      )
    ).rows[0];
    if (inv && inv.status !== "expired") return { kind: "invoice", invoiceId: row.invoice_id, row };
    // Re-quoting after a partial payment would ask the buyer for the full
    // amount again and orphan what they sent, so hand that case to the merchant.
    if (inv && BigInt(inv.received) > 0n)
      return {
        kind: "partial",
        message: "A partial payment was received before this invoice expired. Please contact the store to complete your order.",
        row,
      };
  }

  const order = await fetchOrder(store, gid);
  if (!order) {
    if (row) await client.query(`UPDATE shopify_orders SET state = 'ignored', last_error = 'order not found' WHERE id = $1`, [row.id]);
    return { kind: "not_found", message: "Order not found." };
  }
  if (!row) {
    // Only the pay link reaches here without a queued row; persist it now.
    row = (
      await client.query<ShopifyOrderRow>(
        `INSERT INTO shopify_orders (merchant_id, order_gid, order_id) VALUES ($1, $2, $3)
         ON CONFLICT (merchant_id, order_gid) DO UPDATE SET order_id = EXCLUDED.order_id RETURNING *`,
        [store.merchant_id, gid, orderIdFromGid(gid)]
      )
    ).rows[0];
  }
  await client.query(
    `UPDATE shopify_orders SET order_number = $2, order_name = $3, status_page_url = $4 WHERE id = $1`,
    [row.id, order.number, order.name, order.statusPageUrl]
  );
  const setState = async (state: ShopifyOrderRow["state"], lastError: string | null = null) => {
    await client.query(`UPDATE shopify_orders SET state = $2, last_error = $3 WHERE id = $1`, [row!.id, state, lastError]);
    row = (await read())!;
  };

  if (!isMoneroOrder(store, order.paymentGatewayNames)) {
    await setState("ignored");
    return { kind: "ignored", message: `This order wasn't placed with ${store.payment_method_name}.`, row };
  }
  if (order.cancelledAt) {
    await setState("cancelled");
    return { kind: "cancelled", message: "This order was cancelled.", row };
  }
  const due = order.totalOutstandingSet.presentmentMoney;
  if (order.displayFinancialStatus === "PAID" || Number(due.amount) <= 0) {
    await setState("paid");
    return { kind: "paid", message: "This order is already paid.", row };
  }
  if (!isSupportedCurrency(due.currencyCode)) {
    await setState("error", `store currency ${due.currencyCode} is not supported`);
    return { kind: "error", message: `This store's currency (${due.currencyCode}) isn't supported yet.`, row };
  }

  const inv = await createInvoice(
    { id: store.merchant_id, wallet_name: store.wallet_name, wallet_ready_at: store.wallet_ready_at },
    {
      price_amount: due.amount,
      price_currency: due.currencyCode,
      description: `Shopify order ${order.name} (${store.shop_domain})`,
      expires_in_minutes: INVOICE_EXPIRY_MIN,
      return_url: order.statusPageUrl,
      metadata: { platform: "shopify", shop: store.shop_domain, order_id: orderIdFromGid(gid), order_name: order.name },
    }
  );
  await client.query(
    `UPDATE shopify_orders SET invoice_id = $2, state = 'invoiced', last_error = NULL, attempts = 0 WHERE id = $1`,
    [row.id, inv.id]
  );
  row = (await read())!;
  return { kind: "invoice", invoiceId: inv.id, row };
}

// ---- Worker passes ---------------------------------------------------------

// Poll recent pending orders so a missed or deleted webhook never strands one.
export async function syncStore(store: ShopifyStore): Promise<void> {
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  try {
    const data = await adminGraphql<{
      orders: { nodes: { id: string; name: string; number: number; paymentGatewayNames: string[]; cancelledAt: string | null }[] };
    }>(
      store,
      `query pendingOrders($q: String!) {
        orders(first: 50, sortKey: CREATED_AT, reverse: true, query: $q) {
          nodes { id name number paymentGatewayNames cancelledAt }
        }
      }`,
      { q: `financial_status:pending created_at:>=${since}` }
    );
    for (const o of data.orders.nodes) {
      if (!isMoneroOrder(store, o.paymentGatewayNames)) continue;
      if (o.cancelledAt) await cancelOrder(store.merchant_id, o.id);
      else await enqueueOrder(store.merchant_id, o.id, { number: o.number, name: o.name });
    }
    await query(`UPDATE shopify_stores SET last_synced_at = now(), last_error = NULL WHERE merchant_id = $1`, [
      store.merchant_id,
    ]);
  } catch (e: any) {
    await query(`UPDATE shopify_stores SET last_synced_at = now(), last_error = $2 WHERE merchant_id = $1`, [
      store.merchant_id,
      String(e.message),
    ]);
    throw e;
  }
}

async function syncDueStores(): Promise<void> {
  const { rows } = await query<ShopifyStore>(
    `${STORE_SELECT} WHERE s.last_synced_at IS NULL OR s.last_synced_at < now() - make_interval(secs => $1)`,
    [SYNC_INTERVAL_MS / 1000]
  );
  for (const store of rows) {
    await syncStore(store).catch((e) => console.error(`shopify sync ${store.shop_domain} failed: ${e.message}`));
  }
}

async function recordFailure(rowId: string, message: string): Promise<void> {
  await query(
    `UPDATE shopify_orders SET
       attempts = attempts + 1,
       last_error = $2,
       next_attempt_at = now() + make_interval(secs => LEAST(30 * power(2, attempts), 3600)),
       state = CASE WHEN attempts + 1 >= $3 THEN 'error' ELSE state END
     WHERE id = $1`,
    [rowId, message, MAX_ATTEMPTS]
  );
}

async function processNewOrders(): Promise<void> {
  // Join the store so rows left behind by a disconnected store never occupy
  // the batch and starve everyone else's orders.
  const { rows } = await query<ShopifyOrderRow>(
    `SELECT so.* FROM shopify_orders so JOIN shopify_stores s ON s.merchant_id = so.merchant_id
     WHERE so.state = 'new' AND so.next_attempt_at <= now() ORDER BY so.created_at LIMIT 20`
  );
  for (const row of rows) {
    const store = await loadStoreByMerchant(row.merchant_id);
    if (!store) continue;
    try {
      const r = await ensureInvoice(store, row.order_gid);
      if (r.kind === "invoice") console.log(`shopify ${store.shop_domain} ${r.row.order_name}: invoice ${r.invoiceId}`);
      else console.log(`shopify ${store.shop_domain} order ${row.order_id}: ${r.kind}`);
    } catch (e: any) {
      console.error(`shopify order ${row.order_id} failed: ${e.message}`);
      await recordFailure(row.id, String(e.message));
    }
  }
}

async function markConfirmedOrdersPaid(): Promise<void> {
  const { rows } = await query<ShopifyOrderRow>(
    `SELECT so.* FROM shopify_orders so JOIN invoices i ON i.id = so.invoice_id
     JOIN shopify_stores s ON s.merchant_id = so.merchant_id
     WHERE so.state = 'invoiced' AND i.status = 'confirmed' AND so.next_attempt_at <= now()
     ORDER BY so.created_at LIMIT 20`
  );
  for (const row of rows) {
    const store = await loadStoreByMerchant(row.merchant_id);
    if (!store) continue;
    try {
      const data = await adminGraphql(
        store,
        `mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
          orderMarkAsPaid(input: $input) {
            order { id displayFinancialStatus }
            userErrors { field message }
          }
        }`,
        { input: { id: row.order_gid } }
      );
      const err = userErrorText(data.orderMarkAsPaid.userErrors);
      if (err) {
        // "cannot be marked as paid" also covers an order the merchant already
        // marked by hand; that's the outcome we wanted.
        const order = await fetchOrder(store, row.order_gid);
        if (order?.displayFinancialStatus !== "PAID") throw new Error(err);
      }
      await query(`UPDATE shopify_orders SET state = 'paid', paid_marked_at = now(), last_error = NULL WHERE id = $1`, [
        row.id,
      ]);
      console.log(`shopify ${store.shop_domain} ${row.order_name}: marked paid`);
    } catch (e: any) {
      console.error(`shopify mark-paid ${row.order_name ?? row.order_id} failed: ${e.message}`);
      await recordFailure(row.id, String(e.message));
    }
  }
}

export async function processShopify(): Promise<void> {
  await syncDueStores();
  await processNewOrders();
  await markConfirmedOrdersPaid();
}
