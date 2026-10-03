import { describe, expect, it } from "vitest";
import { atomicFromXmr, xmrFromAtomic, ATOMIC_PER_XMR } from "../src/money.js";

// Amounts are the one place a rounding bug costs real money, so these are
// exact-value tests rather than approximations.
describe("xmrFromAtomic", () => {
  it("formats whole and fractional amounts", () => {
    expect(xmrFromAtomic(0n)).toBe("0");
    expect(xmrFromAtomic(ATOMIC_PER_XMR)).toBe("1");
    expect(xmrFromAtomic(ATOMIC_PER_XMR * 42n)).toBe("42");
    expect(xmrFromAtomic(15_000_000_000n)).toBe("0.015");
  });

  it("keeps the smallest unit and trims trailing zeros", () => {
    expect(xmrFromAtomic(1n)).toBe("0.000000000001");
    expect(xmrFromAtomic(100_000_000_000n)).toBe("0.1");
  });

  it("handles negatives", () => {
    expect(xmrFromAtomic(-ATOMIC_PER_XMR)).toBe("-1");
    expect(xmrFromAtomic(-1n)).toBe("-0.000000000001");
  });

  it("stays exact past the float precision limit", () => {
    // 2^53 piconero is where a JS number would start lying.
    const big = 9_007_199_254_740_993n;
    expect(xmrFromAtomic(big)).toBe("9007.199254740993");
  });
});

describe("atomicFromXmr", () => {
  it("parses decimal strings without float math", () => {
    expect(atomicFromXmr("1")).toBe(ATOMIC_PER_XMR);
    expect(atomicFromXmr("0.015")).toBe(15_000_000_000n);
    expect(atomicFromXmr("0.1")).toBe(100_000_000_000n);
    expect(atomicFromXmr("0.000000000001")).toBe(1n);
  });

  it("accepts numbers as well as strings", () => {
    expect(atomicFromXmr(0.5)).toBe(500_000_000_000n);
  });

  it("rejects anything that is not a positive decimal", () => {
    for (const bad of ["", "abc", "-1", "1.2.3", " ", "1e3", "0x10"]) {
      expect(() => atomicFromXmr(bad)).toThrow(/invalid XMR amount/);
    }
  });

  it("rejects more precision than Monero has", () => {
    expect(() => atomicFromXmr("0.0000000000001")).toThrow(/at most 12 decimal places/);
  });

  it("round-trips", () => {
    for (const v of ["0.015", "1", "1234.567891234567", "0.000000000001"]) {
      expect(xmrFromAtomic(atomicFromXmr(v))).toBe(v);
    }
  });
});
