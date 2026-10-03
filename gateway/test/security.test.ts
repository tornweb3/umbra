import { describe, expect, it, vi } from "vitest";
import { assertSafeWebhookUrl, isPrivateAddress, rateLimit, UnsafeUrlError } from "../src/security.js";

describe("isPrivateAddress", () => {
  it("catches the addresses an SSRF would aim at", () => {
    for (const ip of [
      "127.0.0.1", "127.1.2.3", // loopback
      "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", // private
      "169.254.169.254", // cloud metadata
      "0.0.0.0", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
      "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", // v6
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows real public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.167.0.1", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("treats anything that is not an IP as unsafe until resolved", () => {
    expect(isPrivateAddress("example.com")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("assertSafeWebhookUrl", () => {
  it("accepts a public https URL", async () => {
    await expect(assertSafeWebhookUrl("https://8.8.8.8/hook")).resolves.toBeUndefined();
  });

  it("rejects private and loopback targets", async () => {
    for (const url of ["http://127.0.0.1:8080/hook", "http://10.0.0.5/x", "http://[::1]/x", "http://169.254.169.254/"]) {
      await expect(assertSafeWebhookUrl(url), url).rejects.toThrow(UnsafeUrlError);
    }
  });

  it("rejects schemes that are not http(s)", async () => {
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "gopher://example.com"]) {
      await expect(assertSafeWebhookUrl(url), url).rejects.toThrow(/http\(s\)/);
    }
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeWebhookUrl("not a url")).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects hostnames that do not resolve", async () => {
    await expect(assertSafeWebhookUrl("https://nx.invalid/hook")).rejects.toThrow(/does not resolve/);
  });
});

describe("rateLimit", () => {
  const call = (middleware: ReturnType<typeof rateLimit>, ip = "1.2.3.4") => {
    const req = { ip } as any;
    const res = {
      statusCode: 0,
      body: null as any,
      setHeader: vi.fn(),
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    const next = vi.fn();
    middleware(req, res as any, next);
    return { res, next };
  };

  it("allows up to the limit, then refuses", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) expect(call(limiter).next).toHaveBeenCalled();
    const { res, next } = call(limiter);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(Number));
  });

  it("counts each client separately", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1 });
    expect(call(limiter, "1.1.1.1").next).toHaveBeenCalled();
    expect(call(limiter, "2.2.2.2").next).toHaveBeenCalled();
    expect(call(limiter, "1.1.1.1").next).not.toHaveBeenCalled();
  });

  it("forgets the count once the window passes", () => {
    vi.useFakeTimers();
    try {
      const limiter = rateLimit({ windowMs: 1_000, max: 1 });
      expect(call(limiter).next).toHaveBeenCalled();
      expect(call(limiter).next).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_001);
      expect(call(limiter).next).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can key by something other than the address", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 1, key: () => "same-merchant" });
    expect(call(limiter, "1.1.1.1").next).toHaveBeenCalled();
    expect(call(limiter, "9.9.9.9").next).not.toHaveBeenCalled();
  });
});
