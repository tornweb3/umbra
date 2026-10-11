import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  query: async () => ({ rows: [], rowCount: 0 }),
  pool: { end: async () => {} },
}));

const getXmrRate = vi.fn();
vi.mock("../src/rates.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/rates.js")>();
  return { ...real, getXmrRate: (c: string) => getXmrRate(c) };
});

import { acceptZeroconf, normaliseDevice, PosInputError, type PosDevice } from "../src/pos.js";

const device = (over: Partial<PosDevice> = {}): PosDevice =>
  ({
    id: "d1",
    merchant_id: "m1",
    label: "Counter 1",
    claimed_at: null,
    revoked_at: null,
    expires_at: null,
    last_seen_at: null,
    default_currency: null,
    zeroconf_limit: "0.00",
    zeroconf_currency: "USD",
    tip_presets: [],
    charge_expiry_min: 15,
    created_at: "2026-10-12T00:00:00.000Z",
    ...over,
  }) as PosDevice;

beforeEach(() => {
  getXmrRate.mockReset();
  getXmrRate.mockResolvedValue(300);
});

describe("device settings", () => {
  it("insists on a name", () => {
    expect(() => normaliseDevice({})).toThrow(PosInputError);
    expect(() => normaliseDevice({ label: "   " })).toThrow(/name/);
    expect(normaliseDevice({ label: "Counter 1" })).toMatchObject({ label: "Counter 1" });
  });

  it("defaults to requiring confirmations for everything", () => {
    // A gateway should not pick someone else's risk tolerance for them.
    expect(normaliseDevice({ label: "Till" })).toMatchObject({ zeroconf_limit: "0.00", zeroconf_currency: "USD" });
  });

  it("bounds the 0-conf limit and the window", () => {
    expect(() => normaliseDevice({ label: "T", zeroconf_limit: -1 })).toThrow(/0-conf limit/);
    expect(() => normaliseDevice({ label: "T", zeroconf_limit: 2_000_000 })).toThrow(/0-conf limit/);
    expect(() => normaliseDevice({ label: "T", charge_expiry_min: 2 })).toThrow(/payment window/);
  });

  it("takes tip presets as percentages", () => {
    expect(normaliseDevice({ label: "T", tip_presets: "10 15 20" })).toMatchObject({ tip_presets: "[10,15,20]" });
    expect(() => normaliseDevice({ label: "T", tip_presets: "10 150" })).toThrow(/percentages/);
    expect(() => normaliseDevice({ label: "T", tip_presets: [5, 10, 15, 20, 25] })).toThrow(/four/);
  });
});

describe("the 0-conf policy", () => {
  it("refuses everything when no limit is set", async () => {
    expect(await acceptZeroconf(device(), 1, "USD", 300)).toBe(false);
    expect(await acceptZeroconf(device({ zeroconf_limit: "0.00" }), 0.01, null, null)).toBe(false);
    // No rate lookup needed to say no.
    expect(getXmrRate).not.toHaveBeenCalled();
  });

  it("compares directly when the charge is in the limit's own currency", async () => {
    const d = device({ zeroconf_limit: "25.00", zeroconf_currency: "USD", default_currency: "USD" });
    expect(await acceptZeroconf(d, 20, "USD", 300)).toBe(true);
    expect(await acceptZeroconf(d, 25, "USD", 300)).toBe(true);
    expect(await acceptZeroconf(d, 25.01, "USD", 300)).toBe(false);
    expect(getXmrRate).not.toHaveBeenCalled();
  });

  it("converts an XMR charge through the limit's currency", async () => {
    // 0.05 XMR at 300 USD/XMR is 15 USD, inside a 25 USD limit.
    const d = device({ zeroconf_limit: "25.00", zeroconf_currency: "USD" });
    expect(await acceptZeroconf(d, 0.05, null, null)).toBe(true);
    expect(await acceptZeroconf(d, 0.1, null, null)).toBe(false);
    expect(getXmrRate).toHaveBeenCalledWith("USD");
  });

  it("converts a charge priced in another currency through XMR", async () => {
    // 18 EUR at 360 EUR/XMR is 0.05 XMR, which is 15 USD at 300.
    const d = device({ zeroconf_limit: "25.00", zeroconf_currency: "USD", default_currency: "EUR" });
    expect(await acceptZeroconf(d, 18, "EUR", 360)).toBe(true);
    expect(await acceptZeroconf(d, 40, "EUR", 360)).toBe(false);
  });

  it("refuses when it cannot get a rate, rather than guessing", async () => {
    // Failing closed costs a merchant a few seconds. Failing open costs them
    // the goods.
    getXmrRate.mockRejectedValue(new Error("provider down"));
    const d = device({ zeroconf_limit: "100.00", zeroconf_currency: "USD" });
    expect(await acceptZeroconf(d, 0.001, null, null)).toBe(false);
  });

  it("refuses when the limit currency is not one we can price", async () => {
    const d = device({ zeroconf_limit: "100.00", zeroconf_currency: "ZWL" });
    expect(await acceptZeroconf(d, 0.001, null, null)).toBe(false);
    expect(getXmrRate).not.toHaveBeenCalled();
  });
});
