import { query } from "../../src/db.js";

/**
 * Remove a merchant and everything that points at it.
 *
 * The original schema declares no ON DELETE behaviour on its foreign keys, so
 * children have to go first and in order (shopify_orders references invoices).
 * That is fine in production, where deleting a merchant is not a feature, but
 * test cleanup needs it spelled out.
 */
export async function purgeMerchant(id: string): Promise<void> {
  const children = [
    `DELETE FROM webhook_deliveries WHERE invoice_id IN (SELECT id FROM invoices WHERE merchant_id = $1)`,
    `DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE merchant_id = $1)`,
    `DELETE FROM shopify_orders WHERE merchant_id = $1`,
    `DELETE FROM shopify_stores WHERE merchant_id = $1`,
    `UPDATE invoices SET remainder_of = NULL, accepted_by_device = NULL, pos_device_id = NULL WHERE merchant_id = $1`,
    `DELETE FROM pos_devices WHERE merchant_id = $1`,
    `DELETE FROM invoices WHERE merchant_id = $1`,
    `DELETE FROM payment_pages WHERE merchant_id = $1`,
    `DELETE FROM subaddress_pool WHERE merchant_id = $1`,
    `DELETE FROM merchants WHERE id = $1`,
  ];
  for (const sql of children) await query(sql, [id]);
}
