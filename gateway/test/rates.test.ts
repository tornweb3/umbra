import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRateCache,
  getXmrQuote,
  isImplausible,
  isSupportedCurrency,
  RateUnavailableError,
  seedRate,
  SUPPORTED_CURRENCIES,
} from "../src/rates.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearRateCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string) => unknown) {
  globalThis.fetch = (async (input: any) => {
    const body = handler(String(input));
    if (body instanceof Error) throw body;
    return { ok: true, json: async () => body } as any;
  }) as any;
}

const gecko = (rate: number) => ({ monero: { usd: rate, eur: rate, gbp: rate } });

describe("supported currencies", () => {
  it("covers the common storefront currencies without duplicates", () => {
    expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(40);
    expect(new Set(SUPPORTED_CURRENCIES).size).toBe(SUPPORTED_CURRENCIES.length);
    for (const c of SUPPORTED_CURRENCIES) expect(c).toMatch(/^[A-Z]{3}$/);
    expect(isSupportedCurrency("ZAR")).toBe(true);
    expect(isSupportedCurrency("XYZ")).toBe(false);
  });
});

describe("the implausible-jump guard", () => {
  it("accepts an ordinary move and refuses a wild one", () => {
    expect(isImplausible(310, 300)).toBe(false);
    expect(isImplausible(420, 300)).toBe(false); // 40%, allowed by default
    expect(isImplausible(460, 300)).toBe(true); // 53%
    expect(isImplausible(4, 300)).toBe(true);
  });

  it("has nothing to compare against on the first fetch", () => {
    expect(isImplausible(300, undefined)).toBe(false);
    expect(isImplausible(300, 0)).toBe(false);
  });
});

describe("getXmrQuote", () => {
  it("fetches, caches, and reports the age", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return gecko(300);
    });
    expect(await getXmrQuote("GBP")).toEqual({ rate: 300, ageSeconds: 0 });
    expect(await getXmrQuote("GBP")).toMatchObject({ rate: 300 });
    expect(calls).toBe(1);
  });

  it("ignores a provider's garbage tick and keeps the last known rate", async () => {
    // One bad tick must not sell a laptop for the price of a coffee.
    seedRate("GBP", 300);
    mockFetch(() => gecko(4));
    const quote = await getXmrQuote("GBP");
    expect(quote.rate).toBe(300);
    expect(quote.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("serves a stale rate when every provider is down, with its age", async () => {
    seedRate("GBP", 250, Date.now() - 5 * 60_000);
    mockFetch(() => new Error("network down"));
    const quote = await getXmrQuote("GBP");
    expect(quote.rate).toBe(250);
    expect(quote.ageSeconds).toBeGreaterThan(250);
  });

  it("refuses to quote at all once the last rate is too old", async () => {
    // Past that point, refusing a sale is more honest than guessing a price.
    seedRate("GBP", 250, Date.now() - 60 * 60_000);
    mockFetch(() => new Error("network down"));
    await expect(getXmrQuote("GBP")).rejects.toThrow(RateUnavailableError);
  });

  it("refuses when there is nothing cached and nothing reachable", async () => {
    mockFetch(() => new Error("network down"));
    await expect(getXmrQuote("GBP")).rejects.toThrow(/no recent exchange rate/);
  });

  it("falls back from Kraken to CoinGecko for a pair Kraken lists", async () => {
    mockFetch((url) => (url.includes("kraken") ? new Error("kraken down") : gecko(321)));
    expect((await getXmrQuote("USD")).rate).toBe(321);
  });

  it("reads Kraken's ticker shape when it works", async () => {
    mockFetch((url) =>
      url.includes("kraken") ? { error: [], result: { XXMRZUSD: { c: ["333.33", "1"] } } } : gecko(1)
    );
    expect((await getXmrQuote("USD")).rate).toBeCloseTo(333.33);
  });
});
