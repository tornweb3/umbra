import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isMoneroOrder, orderGid, verifyShopifyHmac, type ShopifyStore } from "../src/shopify.js";

const store = { payment_method_name: "Pay with Monero" } as ShopifyStore;
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64");

describe("verifyShopifyHmac", () => {
  const body = Buffer.from('{"id":123,"name":"#1001"}');

  it("accepts Shopify's base64 signature", () => {
    expect(verifyShopifyHmac("shh", body, sign("shh", body.toString()))).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyShopifyHmac("shh", body, sign("wrong", body.toString()))).toBe(false);
  });

  it("rejects a signature for a different body", () => {
    expect(verifyShopifyHmac("shh", body, sign("shh", '{"id":999}'))).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyShopifyHmac("shh", body, undefined)).toBe(false);
    expect(verifyShopifyHmac("shh", body, "")).toBe(false);
    expect(verifyShopifyHmac("shh", body, "short")).toBe(false);
  });

  it("is sensitive to a single changed byte", () => {
    const tampered = Buffer.from('{"id":124,"name":"#1001"}');
    expect(verifyShopifyHmac("shh", tampered, sign("shh", body.toString()))).toBe(false);
  });
});

describe("isMoneroOrder", () => {
  it("matches the configured method regardless of case or padding", () => {
    expect(isMoneroOrder(store, ["Pay with Monero"])).toBe(true);
    expect(isMoneroOrder(store, ["pay with monero"])).toBe(true);
    expect(isMoneroOrder(store, ["  Pay with Monero  "])).toBe(true);
    expect(isMoneroOrder(store, ["shopify_payments", "Pay with Monero"])).toBe(true);
  });

  it("ignores orders paid another way", () => {
    expect(isMoneroOrder(store, ["shopify_payments"])).toBe(false);
    expect(isMoneroOrder(store, ["Bank Deposit"])).toBe(false);
    expect(isMoneroOrder(store, [])).toBe(false);
    // Near misses must not match: the merchant names the method exactly.
    expect(isMoneroOrder(store, ["Pay with Monero (XMR)"])).toBe(false);
  });
});

describe("orderGid", () => {
  it("builds the global id Shopify expects", () => {
    expect(orderGid(5550000000001)).toBe("gid://shopify/Order/5550000000001");
    expect(orderGid("123")).toBe("gid://shopify/Order/123");
  });
});
