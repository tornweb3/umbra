import { describe, expect, it, vi } from "vitest";
import { escapeHtml, route, UUID_RE } from "../src/http.js";

describe("escapeHtml", () => {
  it("escapes the five characters that matter in markup", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
  });

  it("stringifies whatever it is given", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(null)).toBe("null");
  });
});

describe("UUID_RE", () => {
  it("accepts a uuid and rejects anything else", () => {
    expect(UUID_RE.test("0c0766e8-1a2b-4c3d-8e4f-5a6b7c8d9e0f")).toBe(true);
    expect(UUID_RE.test("0c0766e8-1a2b-4c3d-8e4f-5a6b7c8d9e0")).toBe(false);
    expect(UUID_RE.test("'; DROP TABLE invoices; --")).toBe(false);
    expect(UUID_RE.test("")).toBe(false);
  });
});

describe("route", () => {
  const fakeRes = () => {
    const res: any = {
      headersSent: false,
      code: 0,
      payload: null,
      status(c: number) {
        res.code = c;
        return res;
      },
      json(b: unknown) {
        res.payload = b;
        res.headersSent = true;
        return res;
      },
    };
    return res;
  };

  it("turns a rejected handler into a 500 with a reference", async () => {
    // Express 4 does not catch a rejected async handler: without this the
    // request never answers, which is worse than an error page.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    const handler = route(async () => {
      throw new Error("boom");
    });
    handler({ method: "GET", path: "/x" } as any, res, () => {});
    await new Promise((r) => setImmediate(r));
    expect(res.code).toBe(500);
    expect(res.payload).toMatchObject({ error: "internal error" });
    expect(res.payload.reference).toMatch(/^[0-9a-f]{8}$/);
    // The generic body is tied to the log line by that reference, which is the
    // only thing that makes a 500 debuggable without leaking internals.
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining(res.payload.reference), expect.anything());
    quiet.mockRestore();
  });

  it("leaves a successful handler alone", async () => {
    const res = fakeRes();
    let ran = false;
    route(async () => {
      ran = true;
    })({ method: "GET", path: "/x" } as any, res, () => {});
    await new Promise((r) => setImmediate(r));
    expect(ran).toBe(true);
    expect(res.code).toBe(0);
  });
});
