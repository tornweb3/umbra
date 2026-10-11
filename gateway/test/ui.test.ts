import { describe, expect, it } from "vitest";
import { html, raw, safeUrl, SafeHtml } from "../src/ui/html.js";
import { statusBadge, timestamp, when } from "../src/ui/components.js";
import { CSS, layout } from "../src/ui/layout.js";

describe("html", () => {
  it("escapes an interpolated value", () => {
    const evil = '"><script>alert(1)</script>';
    const out = html`<p>${evil}</p>`.value;
    expect(out).not.toContain("<script>");
    expect(out).toBe("<p>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("escapes the characters that break out of an attribute", () => {
    expect(html`<a title="${"a\"b'c&d<e"}">x</a>`.value).toBe(
      '<a title="a&quot;b&#39;c&amp;d&lt;e">x</a>'
    );
  });

  it("passes a nested html`` result through without double escaping", () => {
    const inner = html`<b>${"a&b"}</b>`;
    expect(html`<p>${inner}</p>`.value).toBe("<p><b>a&amp;b</b></p>");
  });

  it("passes raw() through untouched", () => {
    expect(html`${raw("<hr>")}`.value).toBe("<hr>");
  });

  it("joins arrays and renders empties as nothing", () => {
    expect(html`${[1, 2, 3]}`.value).toBe("123");
    expect(html`${[html`<i>a</i>`, html`<i>b</i>`]}`.value).toBe("<i>a</i><i>b</i>");
    expect(html`a${null}b${undefined}c${false}d${true}e`.value).toBe("abcde");
  });

  it("renders numbers and bigints without escaping them", () => {
    expect(html`${42}${10n}`.value).toBe("4210");
  });

  it("returns a SafeHtml that stringifies to its markup", () => {
    const out = html`<p>x</p>`;
    expect(out).toBeInstanceOf(SafeHtml);
    expect(`${out}`).toBe("<p>x</p>");
  });
});

describe("safeUrl", () => {
  it("allows http and https", () => {
    expect(safeUrl("https://shop.example.com/orders/1042")).toBe("https://shop.example.com/orders/1042");
    expect(safeUrl("http://shop.example.com/x?y=1#z")).toBe("http://shop.example.com/x?y=1#z");
  });

  it("rejects javascript:, data: and vbscript:", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("JavaScript:alert(1)")).toBeNull();
    expect(safeUrl("  javascript:alert(1)  ")).toBeNull();
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects a scheme hidden behind control characters", () => {
    // Browsers strip these while parsing the scheme, so the URL still runs.
    expect(safeUrl("java\tscript:alert(1)")).toBeNull();
    expect(safeUrl("java\nscript:alert(1)")).toBeNull();
    expect(safeUrl("\u0000javascript:alert(1)")).toBeNull();
  });

  it("allows same-origin references", () => {
    expect(safeUrl("/checkout/abc")).toBe("/checkout/abc");
    expect(safeUrl("#section")).toBe("#section");
    expect(safeUrl("?page=2")).toBe("?page=2");
  });

  it("allows monero: only when asked for", () => {
    const uri = "monero:8ABC?tx_amount=0.1";
    expect(safeUrl(uri)).toBeNull();
    expect(safeUrl(uri, ["monero:"])).toBe(uri);
  });

  it("rejects non-strings and empties", () => {
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(safeUrl("")).toBeNull();
    expect(safeUrl("   ")).toBeNull();
  });
});

describe("components", () => {
  it("only ever emits a known status class", () => {
    expect(statusBadge("pending").value).toContain('class="status pending"');
    expect(statusBadge("confirmed", " (10 conf)").value).toContain("confirmed (10 conf)");
    const injected = statusBadge('x" onload="alert(1)');
    expect(injected.value).toContain('class="status unknown"');
    // The text may read "onload=", but it cannot become an attribute: every
    // quote that would have closed the class attribute is escaped.
    expect(injected.value).not.toContain('onload="');
    expect(injected.value).toContain("x&quot; onload=&quot;alert(1)");
  });

  it("renders conditionally", () => {
    expect(when(false, html`<p>no</p>`).value).toBe("");
    expect(when(null, () => html`<p>no</p>`).value).toBe("");
    expect(when(1, html`<p>yes</p>`).value).toBe("<p>yes</p>");
  });

  it("renders a timestamp with a machine-readable attribute", () => {
    expect(timestamp("2026-09-22T11:54:03.184Z").value).toBe(
      '<time datetime="2026-09-22T11:54:03.184Z">2026-09-22 11:54:03Z</time>'
    );
    expect(timestamp(null).value).toContain("never");
  });
});

describe("layout", () => {
  it("escapes the title and keeps pages out of search results by default", () => {
    const out = layout({ title: "Pay <b>1</b> XMR", body: html`<p>x</p>` });
    expect(out).toContain("<title>Pay &lt;b&gt;1&lt;/b&gt; XMR</title>");
    expect(out).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(out).toContain('<link rel="stylesheet" href="/assets/umbra.css">');
    expect(out).toContain('<body class="u-minimal">');
    expect(out.startsWith("<!doctype html>")).toBe(true);
  });

  it("adds portal chrome and deferred scripts when asked", () => {
    const out = layout({
      title: "Dashboard",
      chrome: "portal",
      body: html`<p>x</p>`,
      scripts: ["checkout.js"],
      nav: html`<a href="/portal">Home</a>`,
    });
    expect(out).toContain('<body class="u-portal">');
    expect(out).toContain('<script src="/assets/checkout.js" defer></script>');
    expect(out).toContain("<main><p>x</p></main>");
  });

  it("keeps the buyer-facing look of the checkout page", () => {
    // Moving the page onto the shared sheet must not restyle it.
    expect(CSS).toContain("body.u-minimal { max-width: 560px");
    expect(CSS).toContain(".pending { background: #fff3cd; }");
  });
});
