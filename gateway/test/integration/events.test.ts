// Integration: the webhook events, against a real Postgres. These are all
// about which rows get queued and which do not, so they need real SQL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, query } from "../../src/db.js";
import { createMerchant } from "../../src/merchants.js";
import { DEFAULT_EVENTS, enqueueWebhook, setWebhookEvents, webhookEvents } from "../../src/webhooks.js";
import { purgeMerchant } from "./helpers.js";

const live = Boolean(process.env.TEST_DATABASE_URL);
let merchantId = "";
let index = 100;

async function invoice(opts: { due: string; received?: string; status?: string } = { due: "1" }): Promise<string> {
  const atomic = BigInt(Math.round(Number(opts.due) * 1e12)).toString();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO invoices (merchant_id, amount_atomic, description, subaddress, subaddr_index, expires_at, status)
     VALUES ($1, $2, 'test', $3, $4, now() + interval '1 hour', $5) RETURNING id`,
    [merchantId, atomic, `8EV${index}`, ++index, opts.status ?? "pending"]
  );
  if (opts.received) {
    await query(
      `INSERT INTO payments (invoice_id, txid, amount_atomic, confirmations, confirmed_at)
       VALUES ($1, $2, $3, 10, now())`,
      [rows[0].id, `evtx${index}${Date.now()}`, BigInt(Math.round(Number(opts.received) * 1e12)).toString()]
    );
  }
  return rows[0].id;
}

const queued = async (invoiceId: string): Promise<string[]> => {
  const { rows } = await query<{ event: string }>(`SELECT event FROM webhook_deliveries WHERE invoice_id = $1`, [
    invoiceId,
  ]);
  return rows.map((r) => r.event).sort();
};

describe.skipIf(!live)("webhook events", () => {
  beforeAll(async () => {
    const created = await createMerchant({
      name: "events test",
      address: "5" + "E".repeat(94),
      view_key: "e".repeat(64),
      webhook_url: "https://8.8.8.8/hook",
    });
    merchantId = created.id;
  });

  afterAll(async () => {
    if (merchantId) await purgeMerchant(merchantId);
    await pool.end().catch(() => {});
  });

  it("starts with only the two events that always existed", async () => {
    expect(await webhookEvents(merchantId)).toEqual(DEFAULT_EVENTS);
  });

  it("queues an event the merchant has asked for", async () => {
    const id = await invoice({ due: "1", received: "1" });
    expect(await enqueueWebhook(id, "payment_confirmed")).toBe(true);
    expect(await queued(id)).toEqual(["payment_confirmed"]);
  });

  it("drops an event the merchant has not asked for", async () => {
    // Off by default, so an upgrade cannot surprise an existing handler.
    const id = await invoice({ due: "1" });
    expect(await enqueueWebhook(id, "invoice_expired")).toBe(false);
    expect(await queued(id)).toEqual([]);
  });

  it("queues it once the merchant opts in", async () => {
    await setWebhookEvents(merchantId, ["invoice_expired", "payment_overpaid", "nonsense_event"]);
    const enabled = await webhookEvents(merchantId);
    expect(enabled).toContain("invoice_expired");
    expect(enabled).toContain("payment_overpaid");
    // Unknown names are dropped rather than stored.
    expect(enabled).not.toContain("nonsense_event");
    // And the originals cannot be switched off.
    for (const must of DEFAULT_EVENTS) expect(enabled).toContain(must);

    const id = await invoice({ due: "1" });
    expect(await enqueueWebhook(id, "invoice_expired")).toBe(true);
    expect(await queued(id)).toEqual(["invoice_expired"]);
  });

  it("is exactly once per invoice and event", async () => {
    const id = await invoice({ due: "1" });
    expect(await enqueueWebhook(id, "invoice_expired")).toBe(true);
    expect(await enqueueWebhook(id, "invoice_expired")).toBe(false);
    expect(await queued(id)).toEqual(["invoice_expired"]);
  });

  it("carries the amounts, the source and any extra fields", async () => {
    const id = await invoice({ due: "2", received: "2.5" });
    await enqueueWebhook(id, "payment_overpaid", { overpaid_xmr: "0.5" });
    const { rows } = await query<{ payload: any }>(
      `SELECT payload FROM webhook_deliveries WHERE invoice_id = $1 AND event = 'payment_overpaid'`,
      [id]
    );
    expect(rows[0].payload).toMatchObject({
      event: "payment_overpaid",
      amount_due_xmr: "2",
      amount_received_xmr: "2.5",
      overpaid_xmr: "0.5",
      source: "api",
    });
    expect(rows[0].payload.txids.length).toBe(1);
  });

  it("queues nothing at all for a merchant with no webhook URL", async () => {
    // They poll the API instead; rows for them could never be delivered.
    await query(`UPDATE merchants SET webhook_url = NULL WHERE id = $1`, [merchantId]);
    const id = await invoice({ due: "1", received: "1" });
    expect(await enqueueWebhook(id, "payment_confirmed")).toBe(false);
    expect(await queued(id)).toEqual([]);
    await query(`UPDATE merchants SET webhook_url = 'https://8.8.8.8/hook' WHERE id = $1`, [merchantId]);
  });

  it("accepts every event the constraint allows", async () => {
    // A regression test for the migration: if the CHECK and the code list ever
    // disagree, this fails rather than erroring in production.
    await setWebhookEvents(merchantId, [
      "invoice_expired",
      "payment_underpaid",
      "payment_overpaid",
      "page_goal_reached",
      "pos_charge_accepted",
    ]);
    for (const event of await webhookEvents(merchantId)) {
      const id = await invoice({ due: "1" });
      expect(await enqueueWebhook(id, event), event).toBe(true);
    }
  });
});
