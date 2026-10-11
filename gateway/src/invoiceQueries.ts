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
