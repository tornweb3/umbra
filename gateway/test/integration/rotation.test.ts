// Integration: API key rotation, against a real Postgres.
//
// The grace window lives entirely in SQL (the OR in requireAuth, the throttled
// stamp, the expiry comparison), so mocked unit tests cannot see any of it.
// Runs only with TEST_DATABASE_URL set.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool, query } from "../../src/db.js";
import { createApp } from "../../src/app.js";
import { createMerchant, keyState, revokePreviousKey, rotateApiKey } from "../../src/merchants.js";

const live = Boolean(process.env.TEST_DATABASE_URL);
const app = createApp({ baseUrl: "https://pay.example.com", network: "stagenet" });
const me = (key: string) => request(app).get("/api/me").set("Authorization", `Bearer ${key}`);

let merchantId = "";
let firstKey = "";

describe.skipIf(!live)("API key rotation against a real database", () => {
  beforeAll(async () => {
    const created = await createMerchant({
      name: "rotation test",
      address: "5" + "R".repeat(94),
      view_key: "b".repeat(64),
      webhook_url: null,
    });
    merchantId = created.id;
    firstKey = created.apiKey;
    // /api/me does not need a wallet, but nothing should think it is pending.
    await query(`UPDATE merchants SET wallet_ready_at = now() WHERE id = $1`, [merchantId]);
  });

  afterAll(async () => {
    if (merchantId) await query(`DELETE FROM merchants WHERE id = $1`, [merchantId]);
    await pool.end().catch(() => {});
  });

  it("authenticates the key it issued", async () => {
    expect((await me(firstKey)).status).toBe(200);
    expect((await me("xmr_sk_" + "0".repeat(64))).status).toBe(401);
  });

  it("keeps the old key working during the grace window, and says it is in use", async () => {
    const rotated = await rotateApiKey(merchantId, 60);
    expect(rotated.apiKey).not.toBe(firstKey);
    expect(rotated.previousExpiresAt).toBeTruthy();

    expect((await me(rotated.apiKey)).status).toBe(200);

    // Before the old key is used again, nothing has touched it since rotation.
    let state = await keyState(merchantId);
    expect(state.has_previous).toBe(true);
    expect(state.prev_api_key_last_used_at).toBeNull();

    expect((await me(firstKey)).status).toBe(200);

    // That use is what tells the merchant something still holds the old key.
    state = await keyState(merchantId);
    expect(state.prev_api_key_last_used_at).toBeTruthy();

    firstKey = rotated.apiKey;
  });

  it("stops accepting the old key once it is revoked", async () => {
    const rotated = await rotateApiKey(merchantId, 60);
    expect((await me(firstKey)).status).toBe(200);
    expect(await revokePreviousKey(merchantId)).toBe(true);
    expect((await me(firstKey)).status).toBe(401);
    expect((await me(rotated.apiKey)).status).toBe(200);
    // Nothing left to revoke the second time.
    expect(await revokePreviousKey(merchantId)).toBe(false);
    firstKey = rotated.apiKey;
  });

  it("stops accepting the old key once the window has passed", async () => {
    const rotated = await rotateApiKey(merchantId, 60);
    expect((await me(firstKey)).status).toBe(200);
    await query(`UPDATE merchants SET prev_api_key_expires_at = now() - interval '1 second' WHERE id = $1`, [
      merchantId,
    ]);
    expect((await me(firstKey)).status).toBe(401);
    expect((await keyState(merchantId)).has_previous).toBe(false);
    firstKey = rotated.apiKey;
  });

  it("revokes immediately when asked for no grace at all", async () => {
    const rotated = await rotateApiKey(merchantId, 0);
    expect(rotated.previousExpiresAt).toBeNull();
    expect((await me(firstKey)).status).toBe(401);
    expect((await me(rotated.apiKey)).status).toBe(200);
    firstKey = rotated.apiKey;
  });

  it("caps the grace window rather than trusting the caller", async () => {
    const rotated = await rotateApiKey(merchantId, 999_999);
    const state = await keyState(merchantId);
    const days = (new Date(state.prev_api_key_expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(7.01);
    firstKey = rotated.apiKey;
  });

  it("rotates through the API too", async () => {
    const res = await request(app)
      .post("/api/me/rotate-key")
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ grace_minutes: 30 });
    expect(res.status).toBe(200);
    expect(res.body.api_key).toMatch(/^xmr_sk_[0-9a-f]{64}$/);
    expect(res.body.previous_key_expires_at).toBeTruthy();
    expect((await me(res.body.api_key)).status).toBe(200);

    const revoke = await request(app)
      .post("/api/me/revoke-previous-key")
      .set("Authorization", `Bearer ${res.body.api_key}`);
    expect(revoke.body).toEqual({ ok: true, revoked: true });
    expect((await me(firstKey)).status).toBe(401);
    firstKey = res.body.api_key;
  });

  it("refuses a grace window outside the allowed range", async () => {
    const res = await request(app)
      .post("/api/me/rotate-key")
      .set("Authorization", `Bearer ${firstKey}`)
      .send({ grace_minutes: -1 });
    expect(res.status).toBe(400);
    // The key still works: a rejected request must not have rotated anything.
    expect((await me(firstKey)).status).toBe(200);
  });
});
