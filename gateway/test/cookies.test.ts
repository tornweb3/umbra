import { describe, expect, it } from "vitest";
import { readCookie } from "../src/cookies.js";

const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } }) as any;

describe("readCookie", () => {
  it("returns null when there is no cookie header", () => {
    expect(readCookie(req(), "umbra_session")).toBeNull();
  });

  it("reads a single cookie", () => {
    expect(readCookie(req("umbra_session=abc123"), "umbra_session")).toBe("abc123");
  });

  it("picks the right cookie out of several", () => {
    const header = "other=1; umbra_session=abc123; third=xyz";
    expect(readCookie(req(header), "umbra_session")).toBe("abc123");
    expect(readCookie(req(header), "third")).toBe("xyz");
  });

  it("does not match a name that merely ends with the one asked for", () => {
    expect(readCookie(req("not_umbra_session=abc"), "umbra_session")).toBeNull();
  });

  it("strips one layer of quoting and decodes escapes", () => {
    expect(readCookie(req('umbra_session="abc 123"'), "umbra_session")).toBe("abc 123");
    expect(readCookie(req("umbra_session=a%20b"), "umbra_session")).toBe("a b");
  });

  it("treats a malformed escape as absent rather than throwing", () => {
    expect(readCookie(req("umbra_session=%E0%A4%A"), "umbra_session")).toBeNull();
  });

  it("ignores a valueless segment", () => {
    expect(readCookie(req("broken; umbra_session=ok"), "umbra_session")).toBe("ok");
  });
});
