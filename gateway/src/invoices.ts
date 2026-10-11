// Invoice creation, shared by POST /api/invoices and the Shopify bridge.
import { query } from "./db.js";
import { walletRpc, withWallet } from "./walletRpc.js";
import { withClaim } from "./subaddresses.js";
import { atomicFromXmr } from "./money.js";
import { getXmrRate, isSupportedCurrency, SUPPORTED_CURRENCIES } from "./rates.js";

// Bad caller input; routes map it to 400. Anything else is a server error.
export class InvoiceInputError extends Error {}

// The merchant exists but its view-only wallet is still being built, so
// create_address has nothing to mint from. Routes map this to 503: it is
// temporary and the caller should come back, not change the request.
export class WalletNotReadyError extends Error {
  constructor(message = "this account's wallet is still being prepared; try again shortly") {
    super(message);
  }
}

export interface InvoiceInput {
  amount_xmr?: unknown;
  price_amount?: unknown;
  price_currency?: unknown;
  description?: unknown;
  expires_in_minutes?: unknown;
  return_url?: unknown;
  metadata?: unknown;
}

// Metadata rides along in every webhook payload, so keep it small.
const MAX_METADATA_BYTES = 4096;

export interface CreatedInvoice {
  id: string;
  subaddress: string;
  amountAtomic: bigint;
  fiat: { amount: number; currency: string; rate: number } | null;
  status: string;
  return_url: string | null;
  metadata: Record<string, unknown> | null;
  expires_at: string;
}

export interface CreateOptions {
  /**
   * Take the subaddress from the pre-minted pool instead of minting one.
   *
   * Required for anything an anonymous visitor can trigger: minting inline
   * takes the global wallet lock, so a public page that did it per visitor
   * would stall the merchant's own chain scanner. An empty pool raises
   * PoolEmptyError, which routes turn into a 503, rather than queueing behind
   * the lock.
   */
  pool?: boolean;
}

export async function createInvoice(
  m: { id: string; wallet_name: string; wallet_ready_at?: unknown },
  input: InvoiceInput,
  opts: CreateOptions = {}
): Promise<CreatedInvoice> {
  // Minting a subaddress needs the wallet file the worker creates after
  // signup. Checked before any rate lookup so nothing is quoted in vain.
  if (m.wallet_ready_at === null || m.wallet_ready_at === undefined) throw new WalletNotReadyError();
  const { amount_xmr, price_amount, price_currency, description, expires_in_minutes, return_url, metadata } = input;

  if (return_url !== undefined && return_url !== null) {
    if (typeof return_url !== "string" || !/^https?:\/\//.test(return_url) || return_url.length > 2000)
      throw new InvoiceInputError("return_url must be an http(s) URL");
  }
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata !== "object" || Array.isArray(metadata))
      throw new InvoiceInputError("metadata must be a JSON object");
    if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES)
      throw new InvoiceInputError(`metadata must be at most ${MAX_METADATA_BYTES} bytes of JSON`);
  }

  let amountAtomic: bigint;
  let fiat: CreatedInvoice["fiat"] = null;
  if (price_amount !== undefined || price_currency !== undefined) {
    const amount = Number(price_amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new InvoiceInputError("price_amount must be a positive number");
    if (typeof price_currency !== "string" || !isSupportedCurrency(price_currency))
      throw new InvoiceInputError(`price_currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
    const rate = await getXmrRate(price_currency);
    // Rate is a float market price; sub-piconero rounding error is irrelevant here.
    amountAtomic = BigInt(Math.round((amount / rate) * 1e12));
    fiat = { amount, currency: price_currency, rate };
  } else {
    try {
      amountAtomic = atomicFromXmr(amount_xmr as string);
    } catch (err: any) {
      throw new InvoiceInputError(err.message);
    }
    if (amountAtomic <= 0n) throw new InvoiceInputError("amount_xmr must be positive");
  }

  const expiresMin = expires_in_minutes === undefined ? 60 : Number(expires_in_minutes);
  if (!Number.isInteger(expiresMin) || expiresMin < 5 || expiresMin > 1440)
    throw new InvoiceInputError("expires_in_minutes must be an integer between 5 and 1440");

  const params = (subaddress: string, subaddrIndex: number) => [
    m.id,
    amountAtomic.toString(),
    fiat?.amount ?? null,
    fiat?.currency ?? null,
    fiat?.rate ?? null,
    description ?? "",
    subaddress,
    subaddrIndex,
    (return_url as string) ?? null,
    metadata ? JSON.stringify(metadata) : null,
    expiresMin,
  ];
  const INSERT = `INSERT INTO invoices (merchant_id, amount_atomic, price_amount, price_currency, rate, description, subaddress, subaddr_index, return_url, metadata, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(mins => $11))
     RETURNING id, status, expires_at`;
  const shape = (row: any, subaddress: string): CreatedInvoice => ({
    id: row.id,
    subaddress,
    amountAtomic,
    fiat,
    status: row.status,
    return_url: (return_url as string) ?? null,
    metadata: (metadata as Record<string, unknown>) ?? null,
    expires_at: row.expires_at,
  });

  if (opts.pool) {
    // Claim and insert in one transaction: separately, a failed insert would
    // leak a claimed row and burn an address for nothing.
    return withClaim(m.id, async (client, claimed) => {
      const { rows } = await client.query(INSERT, params(claimed.subaddress, claimed.subaddr_index));
      return shape(rows[0], claimed.subaddress);
    });
  }

  const sub = await withWallet(m.wallet_name, async () => {
    const created = await walletRpc<{ address: string; address_index: number }>("create_address", {
      account_index: 0,
      label: `invoice`,
    });
    // Persist the new subaddress before releasing the wallet lock so a
    // concurrent open by the worker can never lose it (which would make the
    // next invoice re-derive the same index).
    await walletRpc("store").catch(() => {});
    return created;
  });

  const { rows } = await query(INSERT, params(sub.address, sub.address_index));
  return shape(rows[0], sub.address);
}
