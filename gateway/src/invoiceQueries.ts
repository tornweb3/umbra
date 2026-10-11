// The invoice read shape, shared by the public API, the checkout page and
// (soon) the merchant portal. One definition, so the three cannot drift.
import { xmrFromAtomic } from "./money.js";

export const INVOICE_SELECT = `
  SELECT i.id, i.merchant_id, i.amount_atomic, i.price_amount, i.price_currency, i.rate,
         i.description, i.subaddress, i.status, i.expires_at, i.created_at, i.return_url, i.metadata,
         COALESCE(SUM(p.amount_atomic), 0)::bigint AS received_atomic,
         COALESCE(MAX(p.confirmations), 0) AS confirmations
  FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id`;

export interface InvoiceView {
  id: string;
  status: string;
  description: string | null;
  subaddress: string;
  amount_due_atomic: string;
  amount_due_xmr: string;
  amount_received_atomic: string;
  amount_received_xmr: string;
  price_amount: string | null;
  price_currency: string | null;
  rate: number | null;
  confirmations: number;
  metadata: unknown;
  expires_at: string;
  created_at: string;
}

export const INVOICE_STATUSES = ["pending", "detected", "confirmed", "expired"] as const;

export interface ListOptions {
  limit?: number;
  /** Cursor: the id of the last invoice on the previous page. */
  before?: string;
  status?: string;
  /** Matches a description, or the start of an invoice id. */
  q?: string;
}

export interface InvoicePage {
  invoices: InvoiceView[];
  /** Pass as `before` to get the next page, or null at the end. */
  nextBefore: string | null;
}

/**
 * One page of a merchant's invoices, newest first.
 *
 * Keyset rather than OFFSET: the same amount of code, and it cannot skip or
 * repeat rows as new invoices arrive underneath someone who is reading.
 */
export async function listInvoices(
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>,
  merchantId: string,
  opts: ListOptions = {}
): Promise<InvoicePage> {
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || 25), 1), 500);
  const params: unknown[] = [merchantId];
  const where = [`i.merchant_id = $1`];

  if (opts.before) {
    params.push(opts.before);
    // Row-wise comparison against the cursor row, so ties on created_at are
    // still ordered deterministically.
    where.push(`(i.created_at, i.id) < (SELECT created_at, id FROM invoices WHERE id = $${params.length})`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`i.status = $${params.length}`);
  }
  if (opts.q) {
    params.push(`%${opts.q}%`);
    const like = params.length;
    params.push(`${opts.q}%`);
    where.push(`(i.description ILIKE $${like} OR i.id::text LIKE $${params.length})`);
  }
  params.push(limit + 1);

  const { rows } = await query(
    `${INVOICE_SELECT} WHERE ${where.join(" AND ")} GROUP BY i.id
     ORDER BY i.created_at DESC, i.id DESC LIMIT $${params.length}`,
    params
  );
  // One row more than asked for is how we know there is a next page without
  // running a count over the whole table.
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(invoiceJson);
  return { invoices: page, nextBefore: hasMore && page.length ? page[page.length - 1].id : null };
}

export function invoiceJson(row: any): InvoiceView {
  const due = BigInt(row.amount_atomic);
  const received = BigInt(row.received_atomic);
  return {
    id: row.id,
    status: row.status,
    description: row.description,
    subaddress: row.subaddress,
    amount_due_atomic: due.toString(),
    amount_due_xmr: xmrFromAtomic(due),
    amount_received_atomic: received.toString(),
    amount_received_xmr: xmrFromAtomic(received),
    price_amount: row.price_amount,
    price_currency: row.price_currency,
    rate: row.rate,
    confirmations: Number(row.confirmations),
    metadata: row.metadata ?? null,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}
