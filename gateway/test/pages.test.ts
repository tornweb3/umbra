import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  query: async () => ({ rows: [], rowCount: 0 }),
  pool: { end: async () => {} },
}));

import {
  embedSnippets,
  issueTicket,
  normalisePage,
  PageInputError,
  publicProgress,
  resolveAmount,
  slugComplaint,
  slugify,
  ticketComplaint,
  trimAmount,
  type PaymentPage,
} from "../src/pages.js";

const page = (over: Partial<PaymentPage> = {}): PaymentPage =>
  ({
    id: "p1",
    merchant_id: "m1",
    slug: "donate-abc123",
    page_type: "donation",
    price_currency: null,
    amount_fixed: null,
    amount_min: null,
    amount_max: null,
    suggested: null,
    goal_amount: null,
    raised_confirmed: "0",
    supporter_count: 0,
    progress_at: null,
    goal_reached_at: null,
    progress_visibility: "public",
    title: "Donate",
    description: "",
    cta_label: "Pay with Monero",
    success_message: "",
    accent_color: null,
    return_url: null,
    status: "active",
    closes_at: null,
    invoice_expiry_min: 30,
    max_live_invoices: 500,
    created_at: "2026-10-12T00:00:00.000Z",
    ...over,
  }) as PaymentPage;

describe("slugs", () => {
  it("builds a readable stem with a random suffix", () => {
    const slug = slugify("Help the Cats!");
    expect(slug).toMatch(/^help-the-cats-[a-z0-9]{6}$/);
    // The suffix is what makes a global namespace workable: no race for a name.
    expect(slugify("Help the Cats!")).not.toBe(slug);
  });

  it("copes with a title that has no usable characters", () => {
    expect(slugify("!!! ???")).toMatch(/^pay-[a-z0-9]{6}$/);
    expect(slugify("")).toMatch(/^pay-[a-z0-9]{6}$/);
  });

  it("stays inside the length the schema allows", () => {
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it("rejects a slug that is malformed or reserved", () => {
    expect(slugComplaint("ok-slug")).toBeNull();
    expect(slugComplaint("-leading")).toMatch(/lowercase/);
    expect(slugComplaint("Upper")).toMatch(/lowercase/);
    expect(slugComplaint("ab")).toMatch(/lowercase/);
    expect(slugComplaint("has space")).toMatch(/lowercase/);
    expect(slugComplaint("api")).toMatch(/reserved/);
    expect(slugComplaint("portal")).toMatch(/reserved/);
    expect(slugComplaint(42)).toMatch(/lowercase/);
  });
});

describe("mint tickets", () => {
  const now = 1_760_000_000_000;

  it("accepts its own ticket after a moment", () => {
    const ticket = issueTicket("donate-abc123", now);
    expect(ticketComplaint("donate-abc123", ticket, now + 2000)).toBeNull();
  });

  it("refuses one that is too fresh to be a human", () => {
    const ticket = issueTicket("donate-abc123", now);
    expect(ticketComplaint("donate-abc123", ticket, now + 100)).toMatch(/too quick/);
  });

  it("refuses a stale one", () => {
    const ticket = issueTicket("donate-abc123", now);
    expect(ticketComplaint("donate-abc123", ticket, now + 3_600_001 + 2000)).toMatch(/expired/);
  });

  it("refuses a ticket minted for another page", () => {
    const ticket = issueTicket("other-page-x1", now);
    expect(ticketComplaint("donate-abc123", ticket, now + 2000)).toMatch(/expired/);
  });

  it("refuses a tampered or missing ticket", () => {
    const ticket = issueTicket("donate-abc123", now);
    const [issued, mac] = ticket.split(".");
    expect(ticketComplaint("donate-abc123", `${issued}.${mac.slice(0, -1)}x`, now + 2000)).toMatch(/expired/);
    expect(ticketComplaint("donate-abc123", `${Number(issued) - 10_000}.${mac}`, now)).toMatch(/expired/);
    expect(ticketComplaint("donate-abc123", undefined, now)).toMatch(/expired/);
    expect(ticketComplaint("donate-abc123", "nonsense", now)).toMatch(/expired/);
  });
});

describe("page validation", () => {
  it("requires a title and a fixed amount for a fixed page", () => {
    expect(() => normalisePage({ page_type: "fixed", title: "" }, true)).toThrow(/title/);
    expect(() => normalisePage({ page_type: "fixed", title: "A thing" }, true)).toThrow(/amount_fixed/);
    expect(normalisePage({ page_type: "fixed", title: "A thing", amount_fixed: "25" }, true)).toMatchObject({
      page_type: "fixed",
      amount_fixed: "25",
    });
  });

  it("accepts every type it offers, and refuses anything else", () => {
    expect(normalisePage({ page_type: "crowdfund", title: "Goal", goal_amount: "100" }, true)).toMatchObject({
      page_type: "crowdfund",
      goal_amount: "100",
    });
    expect(() => normalisePage({ page_type: "crowdfund", title: "Goal" }, true)).toThrow(/goal_amount/);
    expect(() => normalisePage({ page_type: "subscription", title: "X" }, true)).toThrow(/page_type/);
  });

  it("refuses an unsupported currency", () => {
    expect(() => normalisePage({ title: "T", price_currency: "XYZ" }, true)).toThrow(/price_currency/);
    expect(normalisePage({ title: "T", price_currency: "eur" }, true)).toMatchObject({ price_currency: "EUR" });
  });

  it("refuses amounts that are not positive decimals", () => {
    for (const bad of ["-1", "0", "abc", "1e9", "1.0000000000001"]) {
      expect(() => normalisePage({ title: "T", amount_min: bad }, true), bad).toThrow(/positive amount/);
    }
  });

  it("refuses a max below the min", () => {
    expect(() => normalisePage({ title: "T", amount_min: "10", amount_max: "5" }, true)).toThrow(/amount_max/);
  });

  it("parses suggested amounts from a list or a string", () => {
    expect(normalisePage({ title: "T", suggested: ["5", "10"] }, true).suggested).toBe('["5","10"]');
    expect(normalisePage({ title: "T", suggested: "5 10 25" }, true).suggested).toBe('["5","10","25"]');
    expect(() => normalisePage({ title: "T", suggested: "1 2 3 4 5 6 7" }, true)).toThrow(/at most 6/);
  });

  it("refuses a colour that is not #rrggbb and a return_url that is not http(s)", () => {
    expect(() => normalisePage({ title: "T", accent_color: "red" }, true)).toThrow(/accent_color/);
    expect(() => normalisePage({ title: "T", return_url: "javascript:alert(1)" }, true)).toThrow(/return_url/);
    expect(normalisePage({ title: "T", accent_color: "#B4552D" }, true).accent_color).toBe("#B4552D");
  });

  it("bounds the payment window", () => {
    expect(() => normalisePage({ title: "T", invoice_expiry_min: 2 }, true)).toThrow(/between 5 and 1440/);
    expect(() => normalisePage({ title: "T", invoice_expiry_min: 5000 }, true)).toThrow(/between 5 and 1440/);
    expect(normalisePage({ title: "T" }, true).invoice_expiry_min).toBe(30);
  });
});

describe("resolving what the visitor pays", () => {
  it("ignores the input on a fixed page", () => {
    const p = page({ page_type: "fixed", amount_fixed: "25", price_currency: "USD" });
    expect(resolveAmount(p, "1000")).toMatchObject({ price_amount: "25", price_currency: "USD" });
  });

  it("takes the chosen amount on an open page", () => {
    expect(resolveAmount(page(), "0.5")).toMatchObject({ amount_xmr: "0.5" });
    expect(resolveAmount(page({ price_currency: "EUR" }), "12.50")).toMatchObject({
      price_amount: "12.50",
      price_currency: "EUR",
    });
  });

  it("insists on an amount when the page does not set one", () => {
    expect(() => resolveAmount(page(), "")).toThrow(/Choose an amount in XMR/);
    expect(() => resolveAmount(page({ price_currency: "USD" }), null)).toThrow(/Choose an amount in USD/);
  });

  it("enforces the page's own bounds", () => {
    const p = page({ amount_min: "0.1", amount_max: "2" });
    expect(() => resolveAmount(p, "0.05")).toThrow(/smallest amount is 0.1/);
    expect(() => resolveAmount(p, "3")).toThrow(/largest amount is 2/);
    expect(resolveAmount(p, "1")).toMatchObject({ amount_xmr: "1" });
  });

  it("refuses nonsense amounts", () => {
    for (const bad of ["-1", "0", "abc", "1,5e3", "0.0000000000001"]) {
      expect(() => resolveAmount(page(), bad), bad).toThrow();
    }
    // A thousands separator is a typo, not an attack: strip it.
    expect(resolveAmount(page({ price_currency: "USD" }), "1,000")).toMatchObject({ price_amount: "1000" });
  });

  it("adds a tip on top and records it in piconero", () => {
    const r = resolveAmount(page(), "0.5", "0.05");
    expect(r.amount_xmr).toBe("0.55");
    expect(r.tipAtomic).toBe(50_000_000_000n);
  });

  it("keeps a fiat tip out of tip_atomic, which is an XMR figure", () => {
    const r = resolveAmount(page({ price_currency: "USD" }), "20", "3");
    expect(r.price_amount).toBe("23");
    expect(r.tipAtomic).toBe(0n);
  });

  it("refuses a tip that is not a number", () => {
    expect(() => resolveAmount(page(), "0.5", "lots")).toThrow(/tip/);
  });
});

describe("trimAmount", () => {
  it("strips the padding Postgres adds to numeric(24,12)", () => {
    expect(trimAmount("0.010000000000")).toBe("0.01");
    expect(trimAmount("25.000000000000")).toBe("25");
    expect(trimAmount("1234.500000000000")).toBe("1234.5");
    expect(trimAmount("0.000000000001")).toBe("0.000000000001");
  });

  it("leaves integers and nulls alone", () => {
    expect(trimAmount("100")).toBe("100");
    expect(trimAmount(null)).toBeNull();
  });

  it("never turns a value into an empty string", () => {
    expect(trimAmount("0.000000000000")).toBe("0");
  });
});

describe("embed snippets", () => {
  it("offers a link as the whole feature, and the script as optional", () => {
    const p = page({ slug: "cats-abc123", cta_label: "Donate Monero" });
    const snippets = embedSnippets("https://pay.example.com", p);
    expect(snippets.link).toBe('<a href="https://pay.example.com/p/cats-abc123">Donate Monero</a>');
    expect(snippets.script).toBe('<script src="https://pay.example.com/embed/v1.js" async></script>');
    // No iframe anywhere: a framed payment page hides which origin produced
    // the address the visitor is about to send money to.
    expect(snippets.link + snippets.script).not.toContain("iframe");
  });
});

describe("public progress", () => {
  const funded = (over: Partial<PaymentPage> = {}) =>
    page({
      page_type: "crowdfund",
      goal_amount: "100",
      raised_confirmed: "36.500000000000",
      supporter_count: 7,
      progress_at: "2026-10-12T00:00:00.000Z",
      ...over,
    });

  it("publishes the amount, the goal and a percentage", () => {
    expect(publicProgress(funded())).toMatchObject({
      goal: "100",
      raised: "36.5",
      percent: 37,
      supporters: 7,
      goal_reached: false,
    });
  });

  it("hides the supporter count while it is small", () => {
    // With a handful of supporters, one amount can be recovered by
    // subtracting the others.
    expect(publicProgress(funded({ supporter_count: 4 })).supporters).toBe(0);
  });

  it("publishes only a percentage when asked to", () => {
    const p = publicProgress(funded({ progress_visibility: "percent_only" }));
    expect(p.percent).toBe(37);
    expect(p.raised).toBe("");
    expect(p.supporters).toBe(0);
  });

  it("publishes nothing when asked to", () => {
    const p = publicProgress(funded({ progress_visibility: "private" }));
    expect(p).toMatchObject({ goal: null, raised: "", percent: 0, supporters: 0, goal_reached: false, as_of: null });
  });

  it("caps the percentage and reports a reached goal", () => {
    const p = publicProgress(funded({ raised_confirmed: "250" }));
    expect(p.percent).toBe(100);
    expect(p.goal_reached).toBe(true);
  });
});
