// All amounts are stored and compared as BigInt atomic units (piconero).
// Conversion to/from XMR decimal strings happens only at API/display edges.

export const ATOMIC_PER_XMR = 1_000_000_000_000n;

export function xmrFromAtomic(atomic: bigint): string {
  const neg = atomic < 0n;
  const abs = neg ? -atomic : atomic;
  const whole = abs / ATOMIC_PER_XMR;
  const frac = (abs % ATOMIC_PER_XMR).toString().padStart(12, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

// Parses a decimal XMR string ("0.015") to atomic units without float math.
export function atomicFromXmr(input: string | number): bigint {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid XMR amount: ${input}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 12) throw new Error("XMR amounts have at most 12 decimal places");
  return BigInt(whole) * ATOMIC_PER_XMR + BigInt(frac.padEnd(12, "0") || "0");
}
