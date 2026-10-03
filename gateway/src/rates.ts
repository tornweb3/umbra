// XMR spot rate lookup for fiat-denominated invoices.
// Kraken is primary where it lists the pair, CoinGecko otherwise (and as the
// fallback); results cached for 60s.

// Common storefront currencies. Kraken only lists XMR against USD and EUR, so
// the rest are priced from CoinGecko alone.
export const SUPPORTED_CURRENCIES = [
  "USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "NZD", "SEK", "PLN", "BRL", "INR",
] as const;
const SUPPORTED = SUPPORTED_CURRENCIES;
export type FiatCurrency = (typeof SUPPORTED)[number];
const KRAKEN_CURRENCIES: ReadonlySet<FiatCurrency> = new Set(["USD", "EUR"]);

export function isSupportedCurrency(c: string): c is FiatCurrency {
  return (SUPPORTED as readonly string[]).includes(c);
}

const cache = new Map<string, { rate: number; at: number }>();
const CACHE_MS = 60_000;

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

// Returns fiat units per 1 XMR.
export async function getXmrRate(currency: FiatCurrency): Promise<number> {
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rate;
  let rate: number;
  if (KRAKEN_CURRENCIES.has(currency)) {
    try {
      rate = await fromKraken(currency);
    } catch {
      rate = await fromCoinGecko(currency);
    }
  } else {
    rate = await fromCoinGecko(currency);
  }
  cache.set(currency, { rate, at: Date.now() });
  return rate;
}
