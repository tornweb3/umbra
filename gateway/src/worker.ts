// Payment watcher + webhook dispatcher.
// - Expires pending invoices past expires_at.
// - Polls each merchant wallet (view-only) for incoming transfers to invoice
//   subaddresses; records payments; moves invoices pending -> detected (0-conf)
//   -> confirmed (>= CONFIRMATIONS).
// - Reverts 'detected' invoices whose 0-conf txs vanished from the mempool
//   without confirming (double-spend / dropped tx).
// - Dispatches queued webhooks, HMAC-SHA256-signed, with exponential backoff.
// - Runs the Shopify bridge: invoices new "Pay with Monero" orders and marks
//   them paid once their invoice confirms (see shopify.ts).
import "dotenv/config";
import { pool, query } from "./db.js";
import { hmacSign } from "./crypto.js";
import { walletRpc, withWallet } from "./walletRpc.js";
import { xmrFromAtomic } from "./money.js";
import { provisionPendingWallets } from "./merchants.js";
import { refreshAllProgress } from "./pages.js";
import { enqueueWebhook } from "./webhooks.js";
import { refillPools, sweepClaimedPool } from "./subaddresses.js";
import { sweepExpiredSessions } from "./portal/session.js";
import { processShopify } from "./shopify.js";
import { assertSafeWebhookUrl } from "./security.js";

const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 10);
const MAX_ATTEMPTS = Number(process.env.WEBHOOK_MAX_ATTEMPTS ?? 8);
const REVERT_AFTER_MIN = Number(process.env.REVERT_AFTER_MIN ?? 30);

interface Transfer {
  txid: string;
  amount: number; // atomic units (JSON number; fine below 2^53 ≈ 9000 XMR)
  confirmations?: number;
  subaddr_index: { major: number; minor: number };
}

interface InvoiceRow {
  id: string;
  merchant_id: string;
  metadata: Record<string, unknown> | null;
  amount_atomic: string;
  price_amount: string | null;
  price_currency: string | null;
  rate: string | null;
  subaddr_index: number;
  status: string;
}

async function expireInvoices(): Promise<void> {
  const { rows } = await query<{ id: string; received: string; due: string }>(
    `WITH expired AS (
       UPDATE invoices SET status = 'expired'
       WHERE status = 'pending' AND expires_at < now()
       RETURNING id, amount_atomic
     )
     SELECT e.id, e.amount_atomic AS due,
            COALESCE(SUM(p.amount_atomic), 0)::text AS received
     FROM expired e LEFT JOIN payments p ON p.invoice_id = e.id
     GROUP BY e.id, e.amount_atomic`
  );
  for (const r of rows) {
    const received = BigInt(r.received);
    if (received > 0n) {
      // Part of the money arrived and the window closed. The merchant has to
      // decide what to do about it, so tell them once rather than leaving it
      // to be noticed.
      console.log(`invoice ${r.id}: expired underpaid (${xmrFromAtomic(received)} of ${xmrFromAtomic(BigInt(r.due))} XMR)`);
      await enqueueWebhook(r.id, "payment_underpaid");
    } else {
      console.log(`invoice ${r.id}: expired`);
      await enqueueWebhook(r.id, "invoice_expired");
    }
  }
}

async function scanMerchants(): Promise<void> {
  const { rows: merchants } = await query(
    `SELECT DISTINCT m.id, m.wallet_name, m.webhook_url
     FROM merchants m JOIN invoices i ON i.merchant_id = m.id
     WHERE i.status IN ('pending', 'detected') AND m.wallet_ready_at IS NOT NULL`
  );

  for (const m of merchants) {
    try {
      const transfers = await withWallet(m.wallet_name, async () => {
        await walletRpc("refresh");
        const r = await walletRpc<{ in?: Transfer[]; pool?: Transfer[] }>("get_transfers", {
          in: true,
          pool: true,
          account_index: 0,
        });
        return [...(r.in ?? []), ...(r.pool ?? [])];
      });

      const { rows: invoices } = await query<InvoiceRow>(
        `SELECT id, merchant_id, metadata, amount_atomic, price_amount, price_currency, rate, subaddr_index, status
         FROM invoices WHERE merchant_id = $1 AND status IN ('pending', 'detected')`,
        [m.id]
      );

      for (const inv of invoices) {
        const txs = transfers.filter(
          (t) => t.subaddr_index.major === 0 && t.subaddr_index.minor === inv.subaddr_index
        );

        for (const t of txs) {
          await query(
            `INSERT INTO payments (invoice_id, txid, amount_atomic, confirmations, confirmed_at)
             VALUES ($1, $2, $3, $4::int, CASE WHEN $4::int >= $5::int THEN now() END)
             ON CONFLICT (invoice_id, txid) DO UPDATE SET
               confirmations = EXCLUDED.confirmations,
               confirmed_at = COALESCE(payments.confirmed_at, EXCLUDED.confirmed_at)`,
            [inv.id, t.txid, String(t.amount), t.confirmations ?? 0, CONFIRMATIONS]
          );
        }

        // Reorg/mempool safety: drop stale 0-conf payment rows whose tx no
        // longer exists in the wallet's view (dropped from pool or reorged out).
        const liveTxids = txs.map((t) => t.txid);
        const { rows: dropped } = await query(
          `DELETE FROM payments
           WHERE invoice_id = $1 AND confirmed_at IS NULL AND confirmations = 0
             AND detected_at < now() - make_interval(mins => $2)
             AND NOT (txid = ANY($3::text[]))
           RETURNING txid`,
          [inv.id, REVERT_AFTER_MIN, liveTxids]
        );
        for (const d of dropped) console.log(`invoice ${inv.id}: dropped stale 0-conf tx ${d.txid}`);

        const due = BigInt(inv.amount_atomic);
        const totalAtomic = txs.reduce((s, t) => s + BigInt(t.amount), 0n);
        const confirmedAtomic = txs
          .filter((t) => (t.confirmations ?? 0) >= CONFIRMATIONS)
          .reduce((s, t) => s + BigInt(t.amount), 0n);
        const txids = liveTxids;
        const minConf = txs.length ? Math.min(...txs.map((t) => t.confirmations ?? 0)) : 0;

        if (inv.status === "detected" && dropped.length > 0 && totalAtomic < due) {
          await query(`UPDATE invoices SET status = 'pending' WHERE id = $1 AND status = 'detected'`, [inv.id]);
          await query(
            `DELETE FROM webhook_deliveries WHERE invoice_id = $1 AND event = 'payment_detected'`,
            [inv.id]
          );
          console.log(`invoice ${inv.id}: reverted to pending (0-conf tx vanished)`);
          continue;
        }

        if (inv.status === "pending" && totalAtomic >= due) {
          await query(`UPDATE invoices SET status = 'detected' WHERE id = $1 AND status = 'pending'`, [inv.id]);
          await enqueueWebhook(inv.id, "payment_detected");
          console.log(`invoice ${inv.id}: detected (${xmrFromAtomic(totalAtomic)} XMR, ${txids.length} tx)`);
        }

        if (inv.status !== "confirmed" && confirmedAtomic >= due) {
          await query(`UPDATE invoices SET status = 'confirmed' WHERE id = $1 AND status <> 'confirmed'`, [inv.id]);
          await enqueueWebhook(inv.id, "payment_confirmed");
          console.log(`invoice ${inv.id}: confirmed`);
          if (confirmedAtomic > due) {
            // Kept, not returned: refunds come from the merchant's own wallet.
            await enqueueWebhook(inv.id, "payment_overpaid", {
              overpaid_atomic: (confirmedAtomic - due).toString(),
              overpaid_xmr: xmrFromAtomic(confirmedAtomic - due),
            });
          }
        }
      }
    } catch (e: any) {
      console.error(`scan merchant ${m.id} failed: ${e.message}`);
    }
  }
}

async function dispatchWebhooks(): Promise<void> {
  const { rows } = await query(
    `SELECT d.id, d.event, d.payload, d.attempts, m.webhook_url, m.webhook_secret
     FROM webhook_deliveries d
     JOIN invoices i ON i.id = d.invoice_id
     JOIN merchants m ON m.id = i.merchant_id
     WHERE d.delivered_at IS NULL AND d.attempts < $1 AND d.next_attempt_at <= now()
       AND m.webhook_url IS NOT NULL`,
    [MAX_ATTEMPTS]
  );

  for (const d of rows) {
    const body = JSON.stringify(d.payload);
    const signature = hmacSign(d.webhook_secret, body);
    try {
      // Re-checked per delivery: the host may have been safe when it was saved
      // and point somewhere internal by the time we call it.
      await assertSafeWebhookUrl(d.webhook_url);
      const res = await fetch(d.webhook_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Event": d.event,
          "X-Webhook-Signature": signature,
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        await query(`UPDATE webhook_deliveries SET delivered_at = now(), attempts = attempts + 1 WHERE id = $1`, [d.id]);
        console.log(`webhook ${d.event} for delivery ${d.id}: delivered (HTTP ${res.status})`);
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e: any) {
      const attempts = d.attempts + 1;
      const delaySec = Math.min(5 * 2 ** attempts, 3600);
      await query(
        `UPDATE webhook_deliveries
         SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4)
         WHERE id = $1`,
        [d.id, attempts, String(e.message), delaySec]
      );
      console.error(`webhook delivery ${d.id} attempt ${attempts} failed: ${e.message}; retry in ${delaySec}s`);
    }
  }
}

// Set by SIGTERM/SIGINT so the current pass finishes before we exit, rather
// than dying mid-wallet-operation.
let stopping = false;
let wake: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/**
 * Record that a pass happened.
 *
 * The console reads this to answer "is the worker running?", which is
 * otherwise unanswerable: an API with no worker looks exactly like a quiet
 * one, while provisioning, scanning and delivery all silently never happen.
 */
async function heartbeat(startedAt: number, error: string | null): Promise<void> {
  await query(
    `INSERT INTO worker_heartbeat (id, last_pass_at, pass_ms, last_error)
     VALUES (true, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE SET last_pass_at = now(), pass_ms = $1, last_error = $2`,
    [Date.now() - startedAt, error]
  ).catch((e) => console.error(`heartbeat failed: ${e.message}`));
}

let passes = 0;

async function main(): Promise<void> {
  console.log(`worker started: poll=${POLL_MS}ms confirmations=${CONFIRMATIONS}`);
  while (!stopping) {
    const startedAt = Date.now();
    let failure: string | null = null;
    try {
      await provisionPendingWallets();
      await refillPools();
      await sweepExpiredSessions();
      // Scan before expiring, so a payment that arrived in the last seconds
      // of the window is recorded first. The other order declares an invoice
      // abandoned while its money is sitting unscanned in the mempool, and
      // reports it as "expired with nothing received" when it was paid.
      await scanMerchants();
      await expireInvoices();
      await dispatchWebhooks();
      await refreshAllProgress();
      await processShopify().catch((e) => console.error(`shopify pass failed: ${e.message}`));
    } catch (e: any) {
      failure = String(e.message).slice(0, 500);
      console.error(`worker loop error: ${e.message}`);
    }
    await heartbeat(startedAt, failure);
    // Housekeeping that does not need to run every fifteen seconds.
    if (++passes % 200 === 0) await sweepClaimedPool().catch((e) => console.error(`pool sweep failed: ${e.message}`));
    if (stopping) break;
    await sleep(POLL_MS);
  }
  await pool.end().catch(() => {});
  console.log("worker stopped");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1); // second signal: go now
    console.log(`${signal} received, finishing the current pass`);
    stopping = true;
    wake?.();
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}

main();
