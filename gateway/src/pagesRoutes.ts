// HTTP surface for payment pages: the public page and its mint, plus the
// merchant's CRUD over the API.
import { randomBytes } from "node:crypto";
import type express from "express";
import { query } from "./db.js";
import { merchant, requireAuth, route, UUID_RE } from "./http.js";
import { createInvoice, InvoiceInputError, WalletNotReadyError } from "./invoices.js";
import { merchantLimit, publicLimit } from "./limits.js";
import {
  archivePage,
  assertPageHasRoom,
  embedSnippets,
  createPage,
  issueTicket,
  listPages,
  PageBusyError,
  PageInputError,
  pageById,
  pageBySlug,
  payable,
  publicProgress,
  resolveAmount,
  ticketComplaint,
  updatePage,
  type PaymentPage,
} from "./pages.js";
import { renderPageBusy, renderPageGone, renderPaymentPage } from "./pagesRender.js";
import { RateUnavailableError } from "./rates.js";
import { rateLimit, serverError } from "./security.js";
import { ensurePoolEnabled, PoolEmptyError } from "./subaddresses.js";

/**
 * Per-visitor caps, held in memory on purpose.
 *
 * Nothing about a donor is persisted, not even a salted hash of their address:
 * storing that next to an amount would be a privacy regression in a Monero
 * gateway. These therefore reset on restart and do nothing against a
 * distributed abuser; the durable backstop is the per-page live-invoice cap.
 */
const mintBurstLimit = rateLimit({ windowMs: 60_000, max: 6, message: "Too many attempts. Wait a moment." });
const mintSustainedLimit = rateLimit({
  windowMs: 1_800_000,
  max: 12,
  message: "Too many payment attempts from here. Try again later.",
});

/** Public pages are safe to cache briefly; nothing on them is per-visitor. */
const PAGE_CACHE = "public, max-age=15";

const CSP = (nonce: string) =>
  [
    "default-src 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    // No script-src at all: these pages run no JavaScript.
  ].join("; ");

function publicPageJson(page: PaymentPage) {
  const visible = page.progress_visibility !== "private" && page.page_type === "crowdfund";
  const progress = page.page_type === "crowdfund" ? publicProgress(page) : null;
  return {
    slug: page.slug,
    page_type: page.page_type,
    title: page.title,
    description: page.description,
    cta_label: page.cta_label,
    currency: page.price_currency ?? "XMR",
    amount_fixed: page.amount_fixed,
    amount_min: page.amount_min,
    amount_max: page.amount_max,
    suggested: page.suggested,
    accent_color: page.accent_color,
    closes_at: page.closes_at,
    progress,
    goal: visible ? page.goal_amount : null,
  };
}

export function mountPageRoutes(app: express.Express, baseUrl: string): void {
  // ---- public ------------------------------------------------------------

  app.get("/p/:slug", publicLimit, route(async (req, res) => {
    const page = await pageBySlug(String(req.params.slug).toLowerCase());
    if (!page || !payable(page)) return res.status(404).send(renderPageGone());
    const nonce = randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", CSP(nonce));
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.send(renderPaymentPage(page, { ticket: issueTicket(page.slug), nonce }));
  }));

  // A merchant who wants live progress on their own site reads this from
  // their own code, rather than us serving a badge image to their visitors.
  app.get("/api/pages/:slug/progress", publicLimit, route(async (req, res) => {
    const page = await pageBySlug(String(req.params.slug).toLowerCase());
    if (!page || page.page_type !== "crowdfund" || page.progress_visibility === "private") {
      return res.status(404).json({ error: "not found" });
    }
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.json(publicProgress(page));
  }));

  app.get("/api/pages/:slug/public", publicLimit, route(async (req, res) => {
    const page = await pageBySlug(String(req.params.slug).toLowerCase());
    if (!page || !payable(page)) return res.status(404).json({ error: "not found" });
    res.setHeader("Cache-Control", PAGE_CACHE);
    res.json(publicPageJson(page));
  }));

  /**
   * Mint from a page.
   *
   * A POST, not a GET, and that is a correctness requirement rather than a
   * convention: a GET that minted would be fired by every link unfurler, mail
   * scanner and prefetcher that ever saw the URL.
   */
  const mint = async (req: express.Request, res: express.Response, wantsHtml: boolean) => {
    const page = await pageBySlug(String(req.params.slug).toLowerCase());
    if (!page || !payable(page)) {
      return wantsHtml ? res.status(404).send(renderPageGone()) : res.status(404).json({ error: "not found" });
    }
    const nonce = randomBytes(16).toString("base64");
    const body = (req.body ?? {}) as Record<string, unknown>;

    const fail = (message: string, status = 400) => {
      if (!wantsHtml) return res.status(status).json({ error: message });
      res.setHeader("Content-Security-Policy", CSP(nonce));
      res.status(status).send(
        renderPaymentPage(page, {
          ticket: issueTicket(page.slug),
          nonce,
          error: message,
          amount: typeof body.amount === "string" ? body.amount : undefined,
        })
      );
    };

    const ticketProblem = ticketComplaint(page.slug, body._ticket ?? body.ticket);
    if (ticketProblem) return fail(ticketProblem, 403);

    try {
      const amount = resolveAmount(page, body.amount, body.tip);
      await assertPageHasRoom(page);

      const { rows } = await query<{ id: string; wallet_name: string; wallet_ready_at: string | null }>(
        `SELECT id, wallet_name, wallet_ready_at FROM merchants WHERE id = $1`,
        [page.merchant_id]
      );
      const m = rows[0];
      if (!m) return fail("This payment link is not usable right now.", 404);
      const invoice = await createInvoice(
        m,
        {
          amount_xmr: amount.amount_xmr,
          price_amount: amount.price_amount,
          price_currency: amount.price_currency,
          description: page.title,
          expires_in_minutes: page.invoice_expiry_min,
          return_url: page.return_url ?? undefined,
          metadata: { source: "page", page: page.slug, page_type: page.page_type },
        },
        { pool: true, source: "page", paymentPageId: page.id, tipAtomic: amount.tipAtomic }
      );

      if (wantsHtml) return res.redirect(303, `/checkout/${invoice.id}`);
      return res.status(201).json({
        invoice_id: invoice.id,
        amount_xmr: invoice.amountAtomic.toString(),
        checkout_url: `${baseUrl}/checkout/${invoice.id}`,
      });
    } catch (e: any) {
      if (e instanceof PageInputError || e instanceof InvoiceInputError) return fail(e.message);
      if (
        e instanceof PoolEmptyError ||
        e instanceof PageBusyError ||
        e instanceof WalletNotReadyError ||
        e instanceof RateUnavailableError
      ) {
        res.setHeader("Retry-After", "30");
        if (!wantsHtml) return res.status(503).json({ error: e.message });
        res.setHeader("Content-Security-Policy", CSP(nonce));
        return res.status(503).send(renderPageBusy(page, e.message, nonce));
      }
      throw e;
    }
  };

  app.post("/p/:slug", mintBurstLimit, mintSustainedLimit, route((req, res) => mint(req, res, true)));
  app.post("/api/pages/:slug/charges", mintBurstLimit, mintSustainedLimit, route((req, res) => mint(req, res, false)));

  // ---- merchant ----------------------------------------------------------

  app.get("/api/pages", requireAuth, merchantLimit, route(async (req, res) => {
    res.json((await listPages(merchant(req).id)).map((p) => ({ ...p, url: `${baseUrl}/p/${p.slug}`, embed: embedSnippets(baseUrl, p) })));
  }));

  app.post("/api/pages", requireAuth, merchantLimit, route(async (req, res) => {
    try {
      const page = await createPage(merchant(req).id, req.body ?? {});
      // Anonymous visitors will mint from this page, so it needs a pool.
      await ensurePoolEnabled(merchant(req).id);
      res.status(201).json({ ...page, url: `${baseUrl}/p/${page.slug}`, embed: embedSnippets(baseUrl, page) });
    } catch (e: any) {
      if (e instanceof PageInputError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }));

  app.get("/api/pages/:id", requireAuth, merchantLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const page = await pageById(merchant(req).id, req.params.id);
    if (!page) return res.status(404).json({ error: "not found" });
    res.json({ ...page, url: `${baseUrl}/p/${page.slug}`, embed: embedSnippets(baseUrl, page) });
  }));

  app.patch("/api/pages/:id", requireAuth, merchantLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    try {
      const page = await updatePage(merchant(req).id, req.params.id, req.body ?? {});
      if (!page) return res.status(404).json({ error: "not found" });
      res.json({ ...page, url: `${baseUrl}/p/${page.slug}`, embed: embedSnippets(baseUrl, page) });
    } catch (e: any) {
      if (e instanceof PageInputError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }));

  // Archive, never delete: invoices reference the page, and what someone paid
  // for is worth more than a tidy table.
  app.delete("/api/pages/:id", requireAuth, merchantLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const ok = await archivePage(merchant(req).id, req.params.id, true);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, status: "archived" });
  }));
}
