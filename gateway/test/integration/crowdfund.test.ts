// Integration: crowdfunding progress. No wallet needed, because what is being
// tested is the aggregate over invoices and payments, and that is pure SQL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, query } from "../../src/db.js";
import { createMerchant } from "../../src/merchants.js";
import { createPage, pageBySlug, publicProgress, recomputeProgress, refreshAllProgress } from "../../src/pages.js";
import { purgeMerchant } from "./helpers.js";

const live = Boolean(process.env.TEST_DATABASE_URL);
let merchantId = "";
let index = 0;

/** An invoice on a page, with a payment attached, inserted directly. */
async function paidInvoice(
  pageId: string,
  opts: { xmr: string; rate?: number; currency?: string; confirmed: boolean }
): Promise<string> {
  const atomic = BigInt(Math.round(Number(opts.xmr) * 1e12)).toString();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO invoices (merchant_id, amount_atomic, price_amount, price_currency, rate, description,
                           subaddress, subaddr_index, expires_at, source, payment_page_id, status)
     VALUES ($1, $2, $3, $4, $5, 'test', $6, $7, now() + interval '1 hour', 'page', $8, 'confirmed')
     RETURNING id`,
    [
      merchantId,
      atomic,
      opts.currency ? (Number(opts.xmr) * (opts.rate ?? 1)).toFixed(2) : null,
      opts.currency ?? null,
      opts.rate ?? null,
      `8TEST${index}`,
      ++index,
      pageId,
    ]
  );
  const invoiceId = rows[0].id;
  await query(
    `INSERT INTO payments (invoice_id, txid, amount_atomic, confirmations, confirmed_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [invoiceId, `tx${index}${Date.now()}`, atomic, opts.confirmed ? 10 : 0, opts.confirmed ? new Date() : null]
  );
  return invoiceId;
}

describe.skipIf(!live)("crowdfunding progress", () => {
  beforeAll(async () => {
    const created = await createMerchant({
      name: "crowdfund test",
      address: "5" + "C".repeat(94),
      view_key: "b".repeat(64),
      webhook_url: null,
    });
    merchantId = created.id;
    await query(`UPDATE merchants SET wallet_ready_at = now() WHERE id = $1`, [merchantId]);
  });

  afterAll(async () => {
    if (merchantId) await purgeMerchant(merchantId);
    await pool.end().catch(() => {});
  });

  it("counts confirmed payments only", async () => {
    const page = await createPage(merchantId, { page_type: "crowdfund", title: "XMR goal", goal_amount: "1" });
    await paidInvoice(page.id, { xmr: "0.3", confirmed: true });
    await paidInvoice(page.id, { xmr: "0.4", confirmed: true });
    // Seen but not confirmed: it must not appear in a public figure. A number
    // that can fall looks like fraud, and the fall would publish the amount.
    await paidInvoice(page.id, { xmr: "5", confirmed: false });

    await recomputeProgress(page.id);
    const fresh = (await pageBySlug(page.slug))!;
    expect(fresh.raised_confirmed).toBe("0.7");
    expect(fresh.supporter_count).toBe(2);
    expect(publicProgress(fresh)).toMatchObject({ raised: "0.7", goal: "1", percent: 70, goal_reached: false });
  });

  it("values each payment at its own invoice's locked rate", async () => {
    const page = await createPage(merchantId, {
      page_type: "crowdfund",
      title: "Fiat goal",
      goal_amount: "100",
      price_currency: "USD",
    });
    // Same amount of XMR, very different rates: re-valuing at today's rate
    // would make the total wander, and fall.
    await paidInvoice(page.id, { xmr: "0.1", rate: 200, currency: "USD", confirmed: true });
    await paidInvoice(page.id, { xmr: "0.1", rate: 400, currency: "USD", confirmed: true });

    await recomputeProgress(page.id);
    const fresh = (await pageBySlug(page.slug))!;
    // 0.1 * 200 + 0.1 * 400 = 60
    expect(Number(fresh.raised_confirmed)).toBeCloseTo(60, 6);
    expect(fresh.supporter_count).toBe(2);
  });

  it("marks the goal as reached exactly once", async () => {
    const page = await createPage(merchantId, { page_type: "crowdfund", title: "Small goal", goal_amount: "0.5" });
    await paidInvoice(page.id, { xmr: "0.6", confirmed: true });

    await recomputeProgress(page.id);
    // pg hands back a Date, so compare the instant rather than the object.
    const reachedAt = async () => {
      const { rows } = await query<{ goal_reached_at: Date | null }>(
        `SELECT goal_reached_at FROM payment_pages WHERE id = $1`,
        [page.id]
      );
      return rows[0].goal_reached_at ? new Date(rows[0].goal_reached_at).toISOString() : null;
    };
    const first = await reachedAt();
    expect(first).toBeTruthy();

    // More money arriving must not move the timestamp: the event fires once.
    await paidInvoice(page.id, { xmr: "0.2", confirmed: true });
    await recomputeProgress(page.id);
    expect(await reachedAt()).toBe(first);
    expect(publicProgress((await pageBySlug(page.slug))!).goal_reached).toBe(true);
  });

  it("counts one invoice once, however many transfers paid it", async () => {
    const page = await createPage(merchantId, { page_type: "crowdfund", title: "Split goal", goal_amount: "10" });
    const invoiceId = await paidInvoice(page.id, { xmr: "0.5", confirmed: true });
    // A second transfer to the same invoice: more money, still one supporter.
    await query(
      `INSERT INTO payments (invoice_id, txid, amount_atomic, confirmations, confirmed_at)
       VALUES ($1, $2, $3, 10, now())`,
      [invoiceId, `second${Date.now()}`, "500000000000"]
    );
    await recomputeProgress(page.id);
    const fresh = (await pageBySlug(page.slug))!;
    expect(fresh.raised_confirmed).toBe("1");
    expect(fresh.supporter_count).toBe(1);
  });

  it("ignores another page's payments entirely", async () => {
    const a = await createPage(merchantId, { page_type: "crowdfund", title: "Page A", goal_amount: "5" });
    const b = await createPage(merchantId, { page_type: "crowdfund", title: "Page B", goal_amount: "5" });
    await paidInvoice(a.id, { xmr: "1", confirmed: true });
    await recomputeProgress(a.id);
    await recomputeProgress(b.id);
    expect((await pageBySlug(a.slug))!.raised_confirmed).toBe("1");
    expect((await pageBySlug(b.slug))!.raised_confirmed).toBe("0");
  });

  it("refreshes every open page with a goal in one pass", async () => {
    const page = await createPage(merchantId, { page_type: "crowdfund", title: "Swept goal", goal_amount: "2" });
    await paidInvoice(page.id, { xmr: "0.25", confirmed: true });
    await refreshAllProgress();
    const fresh = (await pageBySlug(page.slug))!;
    expect(fresh.raised_confirmed).toBe("0.25");
    expect(fresh.progress_at).toBeTruthy();
  });

  it("leaves an archived page alone", async () => {
    const page = await createPage(merchantId, { page_type: "crowdfund", title: "Closed goal", goal_amount: "2" });
    await paidInvoice(page.id, { xmr: "1", confirmed: true });
    await query(`UPDATE payment_pages SET status = 'archived' WHERE id = $1`, [page.id]);
    await refreshAllProgress();
    expect((await pageBySlug(page.slug))!.raised_confirmed).toBe("0");
  });
});
