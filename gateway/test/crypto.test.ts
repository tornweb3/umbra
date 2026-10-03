import { createHmac, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hmacSign, newSecret, sha256Hex } from "../src/crypto.js";

describe("encrypt / decrypt", () => {
  it("round-trips a view key", () => {
    const viewKey = "132465492d88dfc38d4f6ba27ead8f8644800054c6d4459d5cc756a93d8d8109";
    expect(decrypt(encrypt(viewKey))).toBe(viewKey);
  });

  it("produces different ciphertext each time", () => {
    // A fresh IV per call: identical plaintexts must not be linkable in the database.
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it("uses the documented layout: 12-byte IV, 16-byte tag, then ciphertext", () => {
    const blob = encrypt("x");
    expect(blob.length).toBe(12 + 16 + 1);
  });

  it("refuses tampered ciphertext", () => {
    const blob = encrypt("secret");
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob)).toThrow();
  });

  it("refuses a tampered auth tag", () => {
    const blob = encrypt("secret");
    blob[12] ^= 0xff;
    expect(() => decrypt(blob)).toThrow();
  });
});

describe("hmacSign", () => {
  it("is plain hex with no prefix, matching what integrations verify", () => {
    const body = '{"event":"payment_confirmed"}';
    const sig = hmacSign("secret", body);
    expect(sig).toBe(createHmac("sha256", "secret").update(body).digest("hex"));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the body or the key changes", () => {
    expect(hmacSign("a", "body")).not.toBe(hmacSign("b", "body"));
    expect(hmacSign("a", "body")).not.toBe(hmacSign("a", "body2"));
  });
});

describe("sha256Hex and newSecret", () => {
  it("hashes api keys the way lookups expect", () => {
    expect(sha256Hex("xmr_sk_test")).toBe(createHash("sha256").update("xmr_sk_test").digest("hex"));
  });

  it("generates 32 bytes of hex, unpredictably", () => {
    const a = newSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(newSecret());
  });
});
