// Integration: enrolling a till and taking a payment on it, against a real
// Postgres and the wallet mock.
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { pool, query } from "../../src/db.js";
import { createMerchant, provisionPendingWallets } from "../../src/merchants.js";
import { refillPools, setPoolTarget } from "../../src/subaddresses.js";
import { purgeMerchant } from "./helpers.js";

const live = Boolean(process.env.TEST_DATABASE_URL);
const app = createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });
let mock: ChildProcess | null = null;
let merchantId = "";
let apiKey = "";
let deviceId = "";
let token = "";

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

const till = (method: "get" | "post", path: string) =>
  request(app)[method](path).set("Authorization", `Bearer ${token}`);

describe.skipIf(!live)("a till end to end", () => {
  beforeAll(async () => {
    mock = spawn(process.execPath, ["tools/wallet-mock.mjs", "4201"], { stdio: "ignore" });
    await waitForMock();
    const created = await createMerchant({
      name: "till test",
      address: "5" + "T".repeat(94),
      view_key: "c".repeat(64),
      webhook_url: null,
    });
    merchantId = created.id;
    apiKey = created.apiKey;
    await provisionPendingWallets();
    await setPoolTarget(merchantId, 8);
    await refillPools();
  }, 30_000);

  afterAll(async () => {
    if (merchantId) await purgeMerchant(merchantId);
    mock?.kill("SIGTERM");
    await pool.end().catch(() => {});
  });

  it("creates a device and hands back a one-time enrolment code", async () => {
    const res = await request(app)
      .post("/api/pos/devices")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ label: "Counter 1", default_currency: "USD", zeroconf_limit: "25", tip_presets: "10 15" });
    expect(res.status).toBe(201);
    expect(res.body.enrol_code).toBeTruthy();
    expect(res.body.enrol_url).toContain("/pos/enrol#");
    deviceId = res.body.device.id;

    // Only a hash of the code is stored.
    const { rows } = await query<{ enrol_code_hash: string; token_hash: string | null }>(
      `SELECT enrol_code_hash, token_hash FROM pos_devices WHERE id = $1`,
      [deviceId]
    );
    expect(rows[0].enrol_code_hash).not.toBe(res.body.enrol_code);
    expect(rows[0].token_hash).toBeNull();

    // Claiming it is what turns it into a credential.
    const claim = await request(app).post("/pos/api/enrol").send({ code: res.body.enrol_code });
    expect(claim.status).toBe(200);
    expect(claim.body.token).toMatch(/^xmr_pos_[0-9a-f]{64}$/);
    token = claim.body.token;

    // And it is single use, so two phones cannot share one credential.
    const again = await request(app).post("/pos/api/enrol").send({ code: res.body.enrol_code });
    expect(again.status).toBe(403);
  });

  it("serves the till app with no merchant data in it", async () => {
    const res = await request(app).get("/pos");
    expect(res.status).toBe(200);
    // Identical bytes for every device: the credential lives in localStorage.
    expect(res.text).not.toContain("Counter 1");
    expect(res.text).not.toContain("till test");
    expect(res.text).toContain('src="/assets/pos.js"');
  });

  it("tells the till its own settings and nothing else", async () => {
    const res = await till("get", "/pos/api/device");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ label: "Counter 1", currency: "USD", zeroconf_limit: "25.00", tip_presets: [10, 15] });
    // No keys, no address, no other invoices.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("xmr_sk");
    expect(body).not.toContain("5TTT");
  });

  it("takes a charge, freezing the 0-conf decision on it", async () => {
    const res = await till("post", "/pos/api/charges").send({ amount: "20" });
    expect(res.status).toBe(201);
    expect(res.body.display_amount).toBe("20.00 USD");
    expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
    expect(res.body.customer_url).toContain("/checkout/");
    // 20 USD is inside the 25 USD limit, so this one may be taken at 0-conf.
    expect(res.body.accept_zeroconf).toBe(true);

    const { rows } = await query<{ source: string; accept_zeroconf: boolean; pos_device_id: string }>(
      `SELECT source, accept_zeroconf, pos_device_id FROM invoices WHERE id = $1`,
      [res.body.id]
    );
    expect(rows[0]).toMatchObject({ source: "pos", accept_zeroconf: true, pos_device_id: deviceId });
  }, 20_000);

  it("refuses 0-conf on a charge above the limit", async () => {
    const res = await till("post", "/pos/api/charges").send({ amount: "80" });
    expect(res.status).toBe(201);
    expect(res.body.accept_zeroconf).toBe(false);
  }, 20_000);

  it("will not cancel a charge that money is already arriving for", async () => {
    const created = await till("post", "/pos/api/charges").send({ amount: "10" });
    const id = created.body.id;
    const { rows } = await query<{ subaddr_index: number }>(`SELECT subaddr_index FROM invoices WHERE id = $1`, [id]);
    await query(
      `INSERT INTO payments (invoice_id, txid, amount_atomic, confirmations) VALUES ($1, $2, $3, 0)`,
      [id, `postx${Date.now()}`, "1000000000"]
    );
    void rows;
    const cancel = await till("post", `/pos/api/charges/${id}/cancel`);
    expect(cancel.status).toBe(409);
    expect(cancel.body.error).toMatch(/already on its way/);
  }, 20_000);

  it("charges the difference rather than rewriting the first quote", async () => {
    const created = await till("post", "/pos/api/charges").send({ amount: "30" });
    const id = created.body.id;
    const due = BigInt(
      (await query<{ amount_atomic: string }>(`SELECT amount_atomic FROM invoices WHERE id = $1`, [id])).rows[0]
        .amount_atomic
    );
    // Half of it arrives.
    await query(`INSERT INTO payments (invoice_id, txid, amount_atomic, confirmations) VALUES ($1, $2, $3, 3)`, [
      id,
      `half${Date.now()}`,
      (due / 2n).toString(),
    ]);

    const remainder = await till("post", `/pos/api/charges/${id}/remainder`);
    expect(remainder.status).toBe(201);
    expect(remainder.body.id).not.toBe(id);

    const rows = await query<{ remainder_of: string; amount_atomic: string }>(
      `SELECT remainder_of, amount_atomic FROM invoices WHERE id = $1`,
      [remainder.body.id]
    );
    expect(rows.rows[0].remainder_of).toBe(id);
    // The original is untouched: its QR is already in the customer's wallet.
    const original = await query<{ amount_atomic: string }>(`SELECT amount_atomic FROM invoices WHERE id = $1`, [id]);
    expect(original.rows[0].amount_atomic).toBe(due.toString());
    expect(BigInt(rows.rows[0].amount_atomic)).toBe(due - due / 2n);
  }, 20_000);

  it("records an operator's acceptance separately from what the chain says", async () => {
    const created = await till("post", "/pos/api/charges").send({ amount: "5" });
    const id = created.body.id;
    const accept = await till("post", `/pos/api/charges/${id}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body.accepted_at).toBeTruthy();

    const { rows } = await query<{ status: string; accepted_at: string }>(
      `SELECT status, accepted_at FROM invoices WHERE id = $1`,
      [id]
    );
    // A till never writes status: that is a statement about the chain.
    expect(rows[0].status).toBe("pending");
    expect(rows[0].accepted_at).toBeTruthy();
  }, 20_000);

  it("lists this device's recent charges so a replacement phone can resume", async () => {
    const res = await till("get", "/pos/api/charges");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(2);
    expect(res.body[0].customer_url).toContain("/checkout/");
  });

  it("serves a receipt whose capability is the invoice id", async () => {
    const created = await till("post", "/pos/api/charges").send({ amount: "7" });
    const res = await request(app).get(`/pos/receipt/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("till test");
    expect(res.text).toContain("7.00 USD");
    expect(res.text).toContain("Counter 1");
  }, 20_000);

  it("refuses a revoked device on its very next request", async () => {
    await request(app)
      .post(`/api/pos/devices/${deviceId}/revoke`)
      .set("Authorization", `Bearer ${apiKey}`)
      .expect(200);
    // No PIN, no waiting for a worker: the credential is simply gone.
    const res = await till("get", "/pos/api/device");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/);
    const charge = await till("post", "/pos/api/charges").send({ amount: "1" });
    expect(charge.status).toBe(401);
  });

  it("lets the merchant issue a fresh code for that device", async () => {
    const res = await request(app)
      .post(`/api/pos/devices/${deviceId}/enrol-code`)
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    const claim = await request(app).post("/pos/api/enrol").send({ code: res.body.enrol_code });
    expect(claim.status).toBe(200);
    token = claim.body.token;
    expect((await till("get", "/pos/api/device")).status).toBe(200);
  });

  it("keeps one merchant's devices out of another's reach", async () => {
    const other = await createMerchant({
      name: "other till owner",
      address: "5" + "U".repeat(94),
      view_key: "d".repeat(64),
      webhook_url: null,
    });
    try {
      const res = await request(app)
        .post(`/api/pos/devices/${deviceId}/revoke`)
        .set("Authorization", `Bearer ${other.apiKey}`);
      expect(res.body.revoked).toBe(false);
      expect((await till("get", "/pos/api/device")).status).toBe(200);
    } finally {
      await purgeMerchant(other.id);
    }
  });
});
