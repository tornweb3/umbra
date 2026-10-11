// Queueing a webhook, shared by the worker, the till and the pages.
//
// Lifted out of the worker because an operator action (a cashier accepting a
// short payment) and a page crossing its goal both need to queue one, and
// duplicating the payload shape is how two of them drift apart.
import { query } from "./db.js";
import { xmrFromAtomic } from "./money.js";

export const WEBHOOK_EVENTS = [
  "payment_detected",
  "payment_confirmed",
  "invoice_expired",
  "payment_underpaid",
  "payment_overpaid",
  "page_goal_reached",
  "pos_charge_accepted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** On by default, because they were the only two events that ever existed. */
export const DEFAULT_EVENTS: WebhookEvent[] = ["payment_detected", "payment_confirmed"];

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Queue one delivery for an invoice.
 *
 * Returns false when nothing was queued: no webhook URL, the merchant has not
 * subscribed to this event, or the row already exists. UNIQUE (invoice_id,
 * event) is what makes every event exactly-once per invoice, so a retrying
 * caller cannot double-send.
 */
export async function enqueueWebhook(
  invoiceId: string,
  event: WebhookEvent,
  extra: Record<string, unknown> = {}
): Promise<boolean> {
  const { rows } = await query<any>(
    `SELECT i.id, i.merchant_id, i.amount_atomic, i.price_amount, i.price_currency, i.rate, i.metadata,
            i.tip_atomic, i.source, i.payment_page_id, i.accepted_at,
            m.webhook_url, m.webhook_events,
            COALESCE(SUM(p.amount_atomic), 0)::bigint AS received_atomic,
            COALESCE(MAX(p.confirmations), 0) AS confirmations,
            COALESCE(array_agg(p.txid) FILTER (WHERE p.txid IS NOT NULL), '{}') AS txids
     FROM invoices i
     JOIN merchants m ON m.id = i.merchant_id
     LEFT JOIN payments p ON p.invoice_id = i.id
     WHERE i.id = $1
     GROUP BY i.id, m.webhook_url, m.webhook_events`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) return false;
  // A merchant with no URL polls the API instead; queueing for them would
  // pile up rows nothing can ever send.
  if (!inv.webhook_url) return false;
  if (!(inv.webhook_events ?? DEFAULT_EVENTS).includes(event)) return false;

  const due = BigInt(inv.amount_atomic);
  const received = BigInt(inv.received_atomic);
  const payload = {
    event,
    invoice_id: inv.id,
    merchant_id: inv.merchant_id,
    amount_due_atomic: due.toString(),
    amount_due_xmr: xmrFromAtomic(due),
    amount_received_atomic: received.toString(),
    amount_received_xmr: xmrFromAtomic(received),
    price_amount: inv.price_amount,
    price_currency: inv.price_currency,
    rate: inv.rate,
    txids: inv.txids ?? [],
    confirmations: Number(inv.confirmations),
    source: inv.source,
    tip_atomic: inv.tip_atomic === undefined ? "0" : String(inv.tip_atomic),
    metadata: inv.metadata ?? null,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  const { rowCount } = await query(
    `INSERT INTO webhook_deliveries (invoice_id, event, payload)
     VALUES ($1, $2, $3) ON CONFLICT (invoice_id, event) DO NOTHING`,
    [invoiceId, event, JSON.stringify(payload)]
  );
  return Boolean(rowCount);
}

/** The events this merchant wants. */
export async function webhookEvents(merchantId: string): Promise<WebhookEvent[]> {
  const { rows } = await query<{ webhook_events: string[] }>(
    `SELECT webhook_events FROM merchants WHERE id = $1`,
    [merchantId]
  );
  return (rows[0]?.webhook_events ?? DEFAULT_EVENTS).filter(isWebhookEvent);
}

export async function setWebhookEvents(merchantId: string, events: unknown): Promise<WebhookEvent[]> {
  const list = Array.isArray(events) ? events : [events];
  const wanted = list.filter(isWebhookEvent);
  // The original two stay on: turning them off would silently break the
  // integration the merchant already has.
  const final = Array.from(new Set([...DEFAULT_EVENTS, ...wanted]));
  await query(`UPDATE merchants SET webhook_events = $2 WHERE id = $1`, [merchantId, final]);
  return final;
}
