// Creating a merchant, and the wallet provisioning that cannot happen inside
// an HTTP request.
//
// generate_from_keys takes the global wallet lock and can run for minutes on a
// synced node. A browser will not wait that long and neither will a reverse
// proxy: nginx closes the connection at 60 seconds by default, and the API key
// in that response is the only copy there will ever be. So signup writes the
// row and hands back the key immediately, and the worker builds the wallet.
import { query } from "./db.js";
import { decrypt, encrypt, newSecret, sha256Hex } from "./crypto.js";
import { createViewOnlyWallet, daemonRpc } from "./walletRpc.js";

export interface NewMerchant {
  name: string;
  address: string;
  view_key: string;
  webhook_url: string | null;
}

export interface ProvisionedMerchant {
  id: string;
  created_at: string;
  apiKey: string;
  webhookSecret: string;
}

/** Insert the merchant. The wallet does not exist yet. */
export async function createMerchant(input: NewMerchant): Promise<ProvisionedMerchant> {
  const walletName = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const webhookSecret = newSecret();
  const apiKey = `xmr_sk_${newSecret()}`;
  const { rows } = await query(
    `INSERT INTO merchants (name, address, view_key_enc, wallet_name, api_key_hash, webhook_url, webhook_secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
    [input.name, input.address, encrypt(input.view_key), walletName, sha256Hex(apiKey), input.webhook_url, webhookSecret]
  );
  return { id: rows[0].id, created_at: rows[0].created_at, apiKey, webhookSecret };
}

/**
 * Build the view-only wallet for any merchant still waiting for one.
 *
 * Called by the worker, which already owns the wallet-lock discipline. A few
 * per pass: each one holds the lock, and the chain scanner needs it too.
 */
export async function provisionPendingWallets(limit = 3): Promise<void> {
  const { rows } = await query<{ id: string; address: string; view_key_enc: Buffer; wallet_name: string }>(
    `SELECT id, address, view_key_enc, wallet_name FROM merchants
     WHERE wallet_ready_at IS NULL ORDER BY created_at LIMIT $1`,
    [limit]
  );

  for (const m of rows) {
    try {
      // Read the height here rather than at signup: it keeps signup working
      // when the daemon is briefly unreachable, and a few minutes of drift is
      // covered by the 100-block margin below.
      const info = await daemonRpc<{ height: number }>("get_info");
      const restoreHeight = Math.max(0, info.height - 100);
      await createViewOnlyWallet(m.wallet_name, m.address, decrypt(m.view_key_enc), restoreHeight);
      await query(`UPDATE merchants SET wallet_ready_at = now(), wallet_error = NULL, restore_height = $2 WHERE id = $1`, [
        m.id,
        restoreHeight,
      ]);
      console.log(`merchant ${m.id}: view-only wallet ready, scanning from height ${restoreHeight}`);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      // A previous attempt may have created the file and then failed to record
      // it. The wallet name is unique per merchant, so an existing file is
      // ours and holds the right keys.
      if (/already exist/i.test(message)) {
        await query(`UPDATE merchants SET wallet_ready_at = now(), wallet_error = NULL WHERE id = $1`, [m.id]);
        console.log(`merchant ${m.id}: wallet file was already present, marking ready`);
        continue;
      }
      await query(`UPDATE merchants SET wallet_error = $2 WHERE id = $1`, [m.id, message.slice(0, 500)]);
      console.error(`merchant ${m.id}: wallet provisioning failed: ${message}`);
    }
  }
}
