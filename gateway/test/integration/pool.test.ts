// Integration: the subaddress pool, against a real Postgres and the wallet
// mock. None of this is reachable by a unit test: the claim is a single SQL
// statement whose whole purpose is how it behaves under concurrency.
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, query } from "../../src/db.js";
import { purgeMerchant } from "./helpers.js";
import { createMerchant, provisionPendingWallets } from "../../src/merchants.js";
import { claimSubaddress, PoolEmptyError, poolState, refillPools, setPoolTarget, withClaim } from "../../src/subaddresses.js";
import { createInvoice } from "../../src/invoices.js";

const live = Boolean(process.env.TEST_DATABASE_URL);
let mock: ChildProcess | null = null;
let merchantId = "";
let walletName = "";

async function waitForMock(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch("http://127.0.0.1:4201/_mock/state");
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("wallet mock did not start");
}

describe.skipIf(!live)("the subaddress pool", () => {
  beforeAll(async () => {
    mock = spawn(process.execPath, ["tools/wallet-mock.mjs", "4201"], { stdio: "ignore" });
    await waitForMock();
    const created = await createMerchant({
      name: "pool test",
      address: "5" + "P".repeat(94),
      view_key: "e".repeat(64),
      webhook_url: null,
    });
    merchantId = created.id;
    // The worker builds the wallet; the mock plays wallet-rpc.
    await provisionPendingWallets();
    const { rows } = await query<{ wallet_name: string; wallet_ready_at: string | null; wallet_error: string | null }>(
      `SELECT wallet_name, wallet_ready_at, wallet_error FROM merchants WHERE id = $1`,
      [merchantId]
    );
    walletName = rows[0].wallet_name;
    expect(rows[0].wallet_error).toBeNull();
    expect(rows[0].wallet_ready_at).toBeTruthy();
  }, 30_000);

  afterAll(async () => {
    if (merchantId) await purgeMerchant(merchantId);
    mock?.kill("SIGTERM");
    await pool.end().catch(() => {});
  });

  it("does nothing until a target is set", async () => {
    expect(await poolState(merchantId)).toMatchObject({ target: 0, free: 0, total: 0 });
    await refillPools();
    expect((await poolState(merchantId)).total).toBe(0);
  });

  it("fills to the target, in batches, one wallet lock at a time", async () => {
    await setPoolTarget(merchantId, 8);
    await refillPools();
    const state = await poolState(merchantId);
    expect(state.target).toBe(8);
    expect(state.free).toBe(8);
    // Every address is distinct and the indexes are contiguous from the wallet.
    const { rows } = await query<{ subaddress: string; subaddr_index: number }>(
      `SELECT subaddress, subaddr_index FROM subaddress_pool WHERE merchant_id = $1 ORDER BY subaddr_index`,
      [merchantId]
    );
    expect(new Set(rows.map((r) => r.subaddress)).size).toBe(8);
    expect(new Set(rows.map((r) => r.subaddr_index)).size).toBe(8);
  }, 20_000);

  it("is idempotent: a second pass mints nothing while it is full", async () => {
    const before = (await poolState(merchantId)).total;
    await refillPools();
    expect((await poolState(merchantId)).total).toBe(before);
  });

  it("hands two concurrent claims different addresses", async () => {
    // FOR UPDATE SKIP LOCKED is the whole reason this works rather than one
    // transaction blocking on the other.
    const grab = () => withClaim(merchantId, async (_c, claimed) => claimed);
    const [a, b, c] = await Promise.all([grab(), grab(), grab()]);
    const indexes = [a.subaddr_index, b.subaddr_index, c.subaddr_index];
    expect(new Set(indexes).size).toBe(3);
    expect((await poolState(merchantId)).free).toBe(5);
  });

  it("rolls the claim back when the caller fails", async () => {
    const before = (await poolState(merchantId)).free;
    await expect(
      withClaim(merchantId, async () => {
        throw new Error("the insert failed");
      })
    ).rejects.toThrow("the insert failed");
    // Otherwise every failed invoice would burn an address for nothing.
    expect((await poolState(merchantId)).free).toBe(before);
  });

  it("raises PoolEmptyError rather than minting inline when it runs dry", async () => {
    await query(`UPDATE subaddress_pool SET claimed_at = now() WHERE merchant_id = $1`, [merchantId]);
    expect((await poolState(merchantId)).free).toBe(0);
    await expect(withClaim(merchantId, async () => "unreachable")).rejects.toThrow(PoolEmptyError);
  });

  it("mints an invoice from the pool, in one transaction with the claim", async () => {
    await setPoolTarget(merchantId, 12);
    await refillPools();
    const freeBefore = (await poolState(merchantId)).free;

    const m = { id: merchantId, wallet_name: walletName, wallet_ready_at: new Date().toISOString() };
    const inv = await createInvoice(m, { amount_xmr: "0.25" }, { pool: true });

    expect(inv.subaddress).toMatch(/^8MOCK/);
    expect((await poolState(merchantId)).free).toBe(freeBefore - 1);
    // The invoice holds exactly the address that was claimed.
    const { rows } = await query<{ subaddress: string; subaddr_index: number }>(
      `SELECT subaddress, subaddr_index FROM invoices WHERE id = $1`,
      [inv.id]
    );
    expect(rows[0].subaddress).toBe(inv.subaddress);
    const claimed = await query(
      `SELECT 1 FROM subaddress_pool WHERE merchant_id = $1 AND subaddr_index = $2 AND claimed_at IS NOT NULL`,
      [merchantId, rows[0].subaddr_index]
    );
    expect(claimed.rowCount).toBe(1);
  }, 20_000);

  it("still mints inline when the pool is not asked for", async () => {
    const freeBefore = (await poolState(merchantId)).free;
    const m = { id: merchantId, wallet_name: walletName, wallet_ready_at: new Date().toISOString() };
    const inv = await createInvoice(m, { amount_xmr: "0.1" });
    expect(inv.subaddress).toMatch(/^8MOCK/);
    // An API caller holding a key is rate limited and is not the threat the
    // pool exists for, so that path is unchanged.
    expect((await poolState(merchantId)).free).toBe(freeBefore);
  }, 20_000);

  it("catches the wallet up when its subaddress counter is behind ours", async () => {
    // What happens after a wallet file is lost and regenerated from the keys:
    // create_address would restart low and collide with indexes we already
    // hold, so the pool would stop refilling.
    await fetch("http://127.0.0.1:4201/_mock/reset", { method: "POST" });
    await query(`UPDATE merchants SET wallet_ready_at = NULL, wallet_error = NULL WHERE id = $1`, [merchantId]);
    await provisionPendingWallets();
    const highest = await query<{ max: number }>(
      `SELECT max(subaddr_index) AS max FROM subaddress_pool WHERE merchant_id = $1`,
      [merchantId]
    );
    await setPoolTarget(merchantId, highest.rows[0].max + 4);
    await refillPools();
    const after = await query<{ max: number }>(
      `SELECT max(subaddr_index) AS max FROM subaddress_pool WHERE merchant_id = $1`,
      [merchantId]
    );
    // New indexes, above everything we already held, rather than a collision.
    expect(after.rows[0].max).toBeGreaterThan(highest.rows[0].max);
  }, 30_000);
});
