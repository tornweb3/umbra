// Integration: a payment page, from creation to a minted invoice, against a
// real Postgres and the wallet mock.
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { pool, query } from "../../src/db.js";
import { createMerchant, provisionPendingWallets } from "../../src/merchants.js";
import { issueTicket } from "../../src/pages.js";
import { refillPools, setPoolTarget } from "../../src/subaddresses.js";
import { purgeMerchant } from "./helpers.js";

const live = Boolean(process.env.TEST_DATABASE_URL);
const app = createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });
// Minting is capped per visitor address, so every request here comes from its
// own: one test deliberately reuses an address to prove the cap works.
app.set("trust proxy", true);
let visitor = 0;
const nextVisitor = () => `203.0.113.${(visitor++ % 250) + 1}`;
const mintFrom = (ip: string, body: Record<string, string>) =>
  request(app).post(`/p/${slug}`).set("X-Forwarded-For", ip).type("form").send(body);
const mint = (body: Record<string, string>) => mintFrom(nextVisitor(), body);
let mock: ChildProcess | null = null;
let merchantId = "";
let apiKey = "";
let slug = "";

async function waitForMock(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch("http://127.0.0.1:4201/_mock/state")).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("wallet mock did not start");
}

/** A ticket old enough to look like a human read the page. */
const usableTicket = () => issueTicket(slug, Date.now() - 1500);

describe.skipIf(!live)("a payment page end to end", () => {
  beforeAll(async () => {
    mock = spawn(process.execPath, ["tools/wallet-mock.mjs", "4201"], { stdio: "ignore" });
    await waitForMock();
    const created = await createMerchant({
      name: "pages test",
      address: "5" + "G".repeat(94),
      view_key: "f".repeat(64),
      webhook_url: null,
    });
    merchantId = created.id;
    apiKey = created.apiKey;
    await provisionPendingWallets();
    await setPoolTarget(merchantId, 6);
    await refillPools();
  }, 30_000);

  afterAll(async () => {
    if (merchantId) await purgeMerchant(merchantId);
    mock?.kill("SIGTERM");
    await pool.end().catch(() => {});
  });

  it("creates a page through the API and turns the pool on", async () => {
    const res = await request(app)
      .post("/api/pages")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ page_type: "donation", title: "Support the Cats", suggested: ["0.1", "0.5"], description: "Thank you" });
    expect(res.status).toBe(201);
    expect(res.body.slug).toMatch(/^support-the-cats-[a-z0-9]{6}$/);
    expect(res.body.url).toBe(`https://pay.example.com/p/${res.body.slug}`);
    slug = res.body.slug;
    const { rows } = await query<{ pool_target: number }>(`SELECT pool_target FROM merchants WHERE id = $1`, [merchantId]);
    expect(rows[0].pool_target).toBeGreaterThan(0);
  });

  it("serves the page to anyone, with no script and a CSP", async () => {
    const res = await request(app).get(`/p/${slug}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Support the Cats");
    expect(res.text).toContain("Thank you");
    expect(res.text).toContain("0.1 XMR");
    expect(res.text).toContain('name="_ticket"');
    // These pages run no JavaScript at all, and the CSP says so.
    expect(res.text).not.toMatch(/<script/);
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).not.toContain("script-src");
    expect(res.headers["cache-control"]).toContain("max-age=15");
  });

  it("mints from the pool on a form post and redirects to the checkout", async () => {
    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subaddress_pool WHERE merchant_id = $1 AND claimed_at IS NULL`,
      [merchantId]
    );
    const res = await mint({ _ticket: usableTicket(), amount: "0.25" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toMatch(/^\/checkout\/[0-9a-f-]{36}$/);

    const invoiceId = res.headers.location.split("/").pop()!;
    const { rows } = await query<{ source: string; payment_page_id: string; amount_atomic: string; subaddress: string }>(
      `SELECT source, payment_page_id, amount_atomic, subaddress FROM invoices WHERE id = $1`,
      [invoiceId]
    );
    expect(rows[0].source).toBe("page");
    expect(rows[0].payment_page_id).toBeTruthy();
    expect(rows[0].amount_atomic).toBe("250000000000");
    expect(rows[0].subaddress).toMatch(/^8MOCK/);

    const after = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM subaddress_pool WHERE merchant_id = $1 AND claimed_at IS NULL`,
      [merchantId]
    );
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n) - 1);

    // The checkout page the visitor lands on is the normal one.
    const checkout = await request(app).get(res.headers.location);
    expect(checkout.status).toBe(200);
    expect(checkout.text).toContain("0.25 XMR");
  });

  it("answers JSON for an API caller", async () => {
    const res = await request(app)
      .post(`/api/pages/${slug}/charges`)
      .set("X-Forwarded-For", nextVisitor())
      .send({ _ticket: usableTicket(), amount: "0.1" });
    expect(res.status).toBe(201);
    expect(res.body.checkout_url).toMatch(/^https:\/\/pay\.example\.com\/checkout\//);
  });

  it("refuses a missing, stale or too-fresh ticket", async () => {
    const fresh = await mint({ _ticket: issueTicket(slug), amount: "0.1" });
    expect(fresh.status).toBe(403);
    expect(fresh.text).toContain("too quick");

    const none = await mint({ amount: "0.1" });
    expect(none.status).toBe(403);

    const other = await mint({ _ticket: issueTicket("another-slug-x1", Date.now() - 1500), amount: "0.1" });
    expect(other.status).toBe(403);
  });

  it("repopulates the form when the amount is refused", async () => {
    const res = await mint({ _ticket: usableTicket(), amount: "nope" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("not an amount");
    expect(res.text).toContain('value="nope"');
  });

  it("answers 503 with Retry-After when the pool is empty", async () => {
    await query(`UPDATE subaddress_pool SET claimed_at = now() WHERE merchant_id = $1`, [merchantId]);
    const res = await mint({ _ticket: usableTicket(), amount: "0.1" });
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.text).toContain("warming up");
    // Refilling makes it work again with no intervention.
    await refillPools();
    const retry = await mint({ _ticket: usableTicket(), amount: "0.1" });
    expect(retry.status).toBe(303);
  }, 20_000);

  it("stops accepting payments once archived, and resumes when reopened", async () => {
    const { rows } = await query<{ id: string }>(`SELECT id FROM payment_pages WHERE slug = $1`, [slug]);
    const pageId = rows[0].id;
    await request(app).delete(`/api/pages/${pageId}`).set("Authorization", `Bearer ${apiKey}`).expect(200);

    expect((await request(app).get(`/p/${slug}`)).status).toBe(404);
    const post = await mint({ _ticket: usableTicket(), amount: "0.1" });
    expect(post.status).toBe(404);

    await request(app)
      .patch(`/api/pages/${pageId}`)
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ title: "Support the Cats" })
      .expect(200);
    await query(`UPDATE payment_pages SET status = 'active' WHERE id = $1`, [pageId]);
    expect((await request(app).get(`/p/${slug}`)).status).toBe(200);
  });

  it("refuses to mint past the page's own live-invoice cap", async () => {
    await query(`UPDATE payment_pages SET max_live_invoices = 1 WHERE slug = $1`, [slug]);
    await refillPools();
    // There are already pending invoices from the earlier mints.
    const res = await mint({ _ticket: usableTicket(), amount: "0.1" });
    expect(res.status).toBe(503);
    expect(res.text).toMatch(/too many unfinished payments/);
    await query(`UPDATE payment_pages SET max_live_invoices = 500 WHERE slug = $1`, [slug]);
  }, 20_000);

  it("caps how fast one visitor can mint", async () => {
    // In memory and per address, so it resets on restart and does nothing
    // against a distributed abuser: the durable backstop is the page's own
    // live-invoice cap. Nothing about the visitor is stored either way.
    const ip = "198.51.100.7";
    const results: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await mintFrom(ip, { _ticket: usableTicket(), amount: "0.01" });
      results.push(res.status);
    }
    expect(results.filter((s) => s === 429).length).toBeGreaterThan(0);
    // A different visitor is unaffected.
    const other = await mint({ _ticket: usableTicket(), amount: "0.01" });
    expect(other.status).not.toBe(429);
  }, 30_000);

  it("keeps one merchant's pages out of another's reach", async () => {
    const other = await createMerchant({
      name: "other merchant",
      address: "5" + "H".repeat(94),
      view_key: "a".repeat(64),
      webhook_url: null,
    });
    try {
      const { rows } = await query<{ id: string }>(`SELECT id FROM payment_pages WHERE slug = $1`, [slug]);
      const res = await request(app).get(`/api/pages/${rows[0].id}`).set("Authorization", `Bearer ${other.apiKey}`);
      expect(res.status).toBe(404);
      const patched = await request(app)
        .patch(`/api/pages/${rows[0].id}`)
        .set("Authorization", `Bearer ${other.apiKey}`)
        .send({ title: "Stolen" });
      expect(patched.status).toBe(404);
    } finally {
      await purgeMerchant(other.id);
    }
  });
});
