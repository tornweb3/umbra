// XMR spot rate lookup for fiat-denominated invoices.
//
// Kraken is primary where it lists the pair, CoinGecko otherwise and as the
// fallback. Two guards sit on top of that, because a wrong rate is not a
// cosmetic problem: it mis-prices a sale, and at a counter the customer has
// already walked away with the goods.
//
//   1. A rate that moved more than RATE_JUMP_REJECT_PCT since the last known
//      one is refused, and the last known one is used instead. One garbage
//      tick from one provider should not sell a laptop for the price of a
//      coffee.
//   2. When every provider is unreachable, the last known rate is served for
//      up to RATE_MAX_STALE_MS, with its age exposed, and after that the quote
//      is refused rather than guessed.

export const SUPPORTED_CURRENCIES = [
  // The original twelve.
  "USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "NZD", "SEK", "PLN", "BRL", "INR",
  // Europe beyond the euro.
  "NOK", "DKK", "CZK", "HUF", "RON", "BGN", "TRY", "UAH", "ISK",
  // The Americas.
  "MXN", "ARS", "CLP", "COP", "PEN",
  // Asia and Oceania.
  "CNY", "HKD", "TWD", "SGD", "KRW", "MYR", "THB", "IDR", "PHP", "VND", "BDT", "PKR", "LKR",
  // Africa and the Middle East.
  "ZAR", "NGN", "KES", "GHS", "EGP", "MAD", "AED", "SAR", "QAR", "ILS",
] as const;
const SUPPORTED = SUPPORTED_CURRENCIES;
export type FiatCurrency = (typeof SUPPORTED)[number];
// Kraken only lists XMR against these; everything else is CoinGecko alone.
const KRAKEN_CURRENCIES: ReadonlySet<FiatCurrency> = new Set(["USD", "EUR"]);

export function isSupportedCurrency(c: string): c is FiatCurrency {
  return (SUPPORTED as readonly string[]).includes(c);
}

/** Thrown when no usable rate exists. Routes turn it into a 503. */
export class RateUnavailableError extends Error {
  constructor(currency: string) {
    super(`no recent exchange rate for ${currency}; try again shortly`);
  }
}

interface Entry {
  rate: number;
  at: number;
}

const cache = new Map<string, Entry>();
const CACHE_MS = 60_000;
/** How long a cached rate may be served when every provider is unreachable. */
const MAX_STALE_MS = Math.max(CACHE_MS, Number(process.env.RATE_MAX_STALE_MS ?? 10 * 60_000));
/** A move larger than this against the last known rate is treated as garbage. */
const JUMP_REJECT_PCT = Math.max(1, Number(process.env.RATE_JUMP_REJECT_PCT ?? 50));

async function fromKraken(currency: FiatCurrency): Promise<number> {
  const pair = `XMR${currency}`;
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const json: any = await res.json();
  if (json.error?.length) throw new Error(`kraken: ${json.error.join(",")}`);
  const key = Object.keys(json.result ?? {})[0];
  const last = Number(json.result?.[key]?.c?.[0]);
  if (!Number.isFinite(last) || last <= 0) throw new Error("kraken: bad ticker");
  return last;
}

async function fromCoinGecko(currency: FiatCurrency): Promise<number> {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=${currency.toLowerCase()}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  const json: any = await res.json();
  const rate = Number(json?.monero?.[currency.toLowerCase()]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("coingecko: bad price");
  return rate;
}

/** True when `fresh` is too far from `known` to be believable. */
export function isImplausible(fresh: number, known: number | undefined, jumpPct = JUMP_REJECT_PCT): boolean {
  if (!known || !Number.isFinite(known) || known <= 0) return false;
  const movePct = (Math.abs(fresh - known) / known) * 100;
  return movePct > jumpPct;
}

export interface Quote {
  rate: number;
  /** How old the rate is, in seconds. Zero when it was just fetched. */
  ageSeconds: number;
}

/** Fiat units per 1 XMR, with its age. */
export async function getXmrQuote(currency: FiatCurrency): Promise<Quote> {
  const known = cache.get(currency);
  if (known && Date.now() - known.at < CACHE_MS) {
    return { rate: known.rate, ageSeconds: Math.round((Date.now() - known.at) / 1000) };
  }

  let fetched: number | null = null;
  const providers = KRAKEN_CURRENCIES.has(currency) ? [fromKraken, fromCoinGecko] : [fromCoinGecko];
  for (const provider of providers) {
    try {
      const rate = await provider(currency);
      if (isImplausible(rate, known?.rate)) {
        console.error(
          `rate for ${currency} from ${provider.name} was ${rate}, more than ${JUMP_REJECT_PCT}% from the last known ${known?.rate}; ignoring it`
        );
        continue;
      }
      fetched = rate;
      break;
    } catch (e: any) {
      console.error(`rate for ${currency} from ${provider.name} failed: ${e.message}`);
    }
  }

  if (fetched !== null) {
    cache.set(currency, { rate: fetched, at: Date.now() });
    return { rate: fetched, ageSeconds: 0 };
  }

  // Nothing usable arrived. A slightly stale rate is better than refusing a
  // sale, up to a point; past that point, refusing is the honest answer.
  if (known && Date.now() - known.at <= MAX_STALE_MS) {
    const ageSeconds = Math.round((Date.now() - known.at) / 1000);
    console.error(`serving a ${ageSeconds}s old rate for ${currency}`);
    return { rate: known.rate, ageSeconds };
  }
  throw new RateUnavailableError(currency);
}

export async function getXmrRate(currency: FiatCurrency): Promise<number> {
  return (await getXmrQuote(currency)).rate;
}

/** Testing seam: the cache is process-wide and deliberately not per request. */
export function clearRateCache(): void {
  cache.clear();
}

/** Testing seam: seed a known rate so the guards can be exercised. */
export function seedRate(currency: string, rate: number, at = Date.now()): void {
  cache.set(currency, { rate, at });
}
