// The subaddress pool.
//
// Rule the whole design rests on: an anonymous visitor never touches the
// wallet lock. The worker mints in batches and a request only claims a row
// that is already sitting there.
import type { PoolClient } from "pg";
import { pool, query } from "./db.js";
import { walletRpc, withWallet } from "./walletRpc.js";

/** How many to mint in one lock acquisition. */
const BATCH = Math.max(1, Number(process.env.SUBADDRESS_POOL_BATCH ?? 25));
/** What a merchant's pool_target becomes when something first needs a pool. */
export const DEFAULT_POOL_TARGET = Math.max(1, Number(process.env.SUBADDRESS_POOL_TARGET ?? 100));

export class PoolEmptyError extends Error {
  constructor() {
    // Visitor-facing: a stranger on a donation page should read this and come
    // back, not conclude the site is broken.
    super("Payments are warming up. Try again in a moment.");
  }
}

export interface Claimed {
  subaddress: string;
  subaddr_index: number;
}

/**
 * Take one address out of the pool.
 *
 * Must run inside the caller's transaction, together with whatever it writes
 * next: claiming and inserting separately would leak a claimed-but-unused row
 * every time the insert failed. FOR UPDATE SKIP LOCKED is what lets two
 * concurrent claims get different rows instead of blocking on each other.
 */
export async function claimSubaddress(client: PoolClient, merchantId: string): Promise<Claimed | null> {
  const { rows } = await client.query<Claimed>(
    `UPDATE subaddress_pool SET claimed_at = now()
     WHERE (merchant_id, subaddr_index) = (
       SELECT merchant_id, subaddr_index FROM subaddress_pool
       WHERE merchant_id = $1 AND claimed_at IS NULL
       ORDER BY subaddr_index
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     RETURNING subaddress, subaddr_index`,
    [merchantId]
  );
  return rows[0] ?? null;
}

export interface PoolState {
  target: number;
  free: number;
  total: number;
}

export async function poolState(merchantId: string): Promise<PoolState> {
  const { rows } = await query<{ target: number; free: string; total: string }>(
    `SELECT m.pool_target AS target,
            count(p.*) FILTER (WHERE p.claimed_at IS NULL)::text AS free,
            count(p.*)::text AS total
     FROM merchants m LEFT JOIN subaddress_pool p ON p.merchant_id = m.id
     WHERE m.id = $1 GROUP BY m.pool_target`,
    [merchantId]
  );
  const r = rows[0];
  return { target: r?.target ?? 0, free: Number(r?.free ?? 0), total: Number(r?.total ?? 0) };
}

export async function setPoolTarget(merchantId: string, target: number): Promise<number> {
  const clamped = Math.min(Math.max(Math.trunc(target) || 0, 0), 10_000);
  await query(`UPDATE merchants SET pool_target = $2 WHERE id = $1`, [merchantId, clamped]);
  return clamped;
}

/** Raise the target to the default if the merchant has no pool configured yet. */
export async function ensurePoolEnabled(merchantId: string): Promise<void> {
  await query(`UPDATE merchants SET pool_target = $2 WHERE id = $1 AND pool_target = 0`, [
    merchantId,
    DEFAULT_POOL_TARGET,
  ]);
}

/**
 * Make the wallet's own subaddress counter catch up with ours.
 *
 * create_address numbers from whatever the wallet file knows. If a wallet is
 * lost and regenerated from the keys it restarts near zero, and the next mint
 * would hand out an index that an existing invoice already owns: the UNIQUE on
 * (merchant_id, subaddr_index) would reject it, loudly, but the pool would
 * then never refill. Called with the wallet already open.
 */
async function reconcile(merchantId: string): Promise<void> {
  const { rows } = await query<{ highest: number | null }>(
    `SELECT GREATEST(
              COALESCE((SELECT max(subaddr_index) FROM invoices WHERE merchant_id = $1), -1),
              COALESCE((SELECT max(subaddr_index) FROM subaddress_pool WHERE merchant_id = $1), -1)
            ) AS highest`,
    [merchantId]
  );
  const highest = rows[0]?.highest ?? -1;
  if (highest < 0) return;
  const wallet = await walletRpc<{ addresses: Array<{ address_index: number }> }>("get_address", {
    account_index: 0,
  });
  let walletHighest = Math.max(-1, ...wallet.addresses.map((a) => a.address_index));
  if (walletHighest >= highest) return;
  console.log(`pool: wallet knows up to index ${walletHighest} but we hold ${highest}; catching up`);
  while (walletHighest < highest) {
    const created = await walletRpc<{ address_index: number }>("create_address", { account_index: 0, label: "catchup" });
    walletHighest = created.address_index;
  }
  await walletRpc("store").catch(() => {});
}

/**
 * Top up every merchant's pool that is below target.
 *
 * One lock acquisition per merchant per pass, not one per address: that is the
 * entire point. The chain scanner wants the same lock, so this is deliberately
 * batched and bounded.
 */
export async function refillPools(): Promise<void> {
  const { rows: due } = await query<{ id: string; wallet_name: string; target: number; free: string }>(
    `SELECT m.id, m.wallet_name, m.pool_target AS target,
            count(p.*) FILTER (WHERE p.claimed_at IS NULL)::text AS free
     FROM merchants m LEFT JOIN subaddress_pool p ON p.merchant_id = m.id
     WHERE m.pool_target > 0 AND m.wallet_ready_at IS NOT NULL
     GROUP BY m.id, m.wallet_name, m.pool_target
     HAVING count(p.*) FILTER (WHERE p.claimed_at IS NULL) < m.pool_target`
  );

  for (const m of due) {
    const want = Math.min(m.target - Number(m.free), BATCH);
    if (want <= 0) continue;
    try {
      const minted = await withWallet(m.wallet_name, async () => {
        await reconcile(m.id);
        const made: Claimed[] = [];
        for (let i = 0; i < want; i++) {
          const created = await walletRpc<{ address: string; address_index: number }>("create_address", {
            account_index: 0,
            label: "pool",
          });
          made.push({ subaddress: created.address, subaddr_index: created.address_index });
        }
        // One store for the whole batch, before the lock is released, so a
        // crash cannot lose addresses we are about to hand out.
        await walletRpc("store").catch(() => {});
        return made;
      });

      for (const a of minted) {
        await query(
          `INSERT INTO subaddress_pool (merchant_id, subaddr_index, subaddress) VALUES ($1, $2, $3)
           ON CONFLICT (merchant_id, subaddr_index) DO NOTHING`,
          [m.id, a.subaddr_index, a.subaddress]
        );
      }
      console.log(`pool: minted ${minted.length} for merchant ${m.id} (target ${m.target})`);
    } catch (e: any) {
      console.error(`pool refill for merchant ${m.id} failed: ${e.message}`);
    }
  }
}

/**
 * Delete pool rows whose invoice never happened.
 *
 * Nothing reuses an index, ever: a published subaddress stays burned. This
 * only removes rows claimed long ago whose invoice is gone, so the table does
 * not grow without bound.
 */
export async function sweepClaimedPool(): Promise<void> {
  await query(
    `DELETE FROM subaddress_pool p
     WHERE p.claimed_at < now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.merchant_id = p.merchant_id AND i.subaddr_index = p.subaddr_index)`
  );
}

/** For the request path: claim inside a transaction the caller controls. */
export async function withClaim<T>(
  merchantId: string,
  fn: (client: PoolClient, claimed: Claimed) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await claimSubaddress(client, merchantId);
    if (!claimed) {
      await client.query("ROLLBACK");
      throw new PoolEmptyError();
    }
    try {
      const result = await fn(client, claimed);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    client.release();
  }
}
