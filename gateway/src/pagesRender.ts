// The public payment page.
//
// Deliberately plain HTML with one form and no JavaScript: the form posts, the
// server mints, and the response is a redirect to the checkout page. A visitor
// with scripts blocked, which describes a fair share of this audience, gets
// exactly the same experience.
import { layout } from "./ui/layout.js";
import { when } from "./ui/components.js";
import { html, raw, safeUrl, type SafeHtml } from "./ui/html.js";
import type { PaymentPage } from "./pages.js";

function unitOf(page: PaymentPage): string {
  return page.price_currency ?? "XMR";
}

/**
 * The merchant's accent colour.
 *
 * A <style> element rather than a style attribute, because a CSP that allowed
 * inline style attributes would allow a great deal else. The value matches a
 * #rrggbb CHECK constraint in the schema, so there is nothing to escape, and
 * the nonce is what the CSP on this response allows.
 */
function accent(page: PaymentPage, nonce: string): SafeHtml {
  if (!page.accent_color) return html``;
  return raw(`<style nonce="${nonce}">:root{--accent:${page.accent_color}}</style>`);
}

function progress(page: PaymentPage): SafeHtml {
  if (page.page_type !== "crowdfund" || !page.goal_amount) return html``;
  if (page.progress_visibility === "private") return html``;
  const raised = Number(page.raised_confirmed);
  const goal = Number(page.goal_amount);
  const percent = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
  const unit = unitOf(page);
  // <progress> rather than a div with a width: native, accessible, and it
  // needs no inline style.
  return html`<div class="goal">
<progress class="goal-bar" value="${percent}" max="100">${percent}%</progress>
${when(
  page.progress_visibility === "public",
  () => html`<p class="goal-text"><strong>${page.raised_confirmed} ${unit}</strong> of ${page.goal_amount} ${unit}
${when(page.supporter_count >= 5, () => html` from ${page.supporter_count} supporters`)}
${when(page.supporter_count > 0 && page.supporter_count < 5, () => html` from a few supporters`)}</p>`
)}
${when(page.progress_visibility === "percent_only", () => html`<p class="goal-text">${percent}% of the way there</p>`)}
</div>`;
}

export interface PageViewOptions {
  ticket: string;
  /** Allows the one <style> element this page may carry. */
  nonce: string;
  error?: string;
  /** Repopulated when the amount was rejected. */
  amount?: string;
}

export function renderPaymentPage(page: PaymentPage, opts: PageViewOptions): string {
  const unit = unitOf(page);
  const back = safeUrl(page.return_url);
  const open = page.page_type !== "fixed";

  const body = html`<div class="pay-page">
<h1>${page.title}</h1>
${when(page.description, () => html`<p class="pay-description">${page.description}</p>`)}
${progress(page)}
${when(opts.error, () => html`<div class="banner error">${opts.error}</div>`)}

<form method="post" action="/p/${page.slug}">
<input type="hidden" name="_ticket" value="${opts.ticket}">
${when(
  !open,
  () => html`<p class="pay-amount">${page.amount_fixed} <span class="pay-unit">${unit}</span></p>`
)}
${when(
  open,
  () => html`${when(
    page.suggested && page.suggested.length,
    () => html`<div class="pay-suggested">${page.suggested!.map(
      (s) => html`<button type="submit" name="amount" value="${s}" class="secondary">${s} ${unit}</button>`
    )}</div>
<p class="muted">or enter an amount</p>`
  )}
<label for="amount">Amount in ${unit}</label>
<input id="amount" name="amount" inputmode="decimal" value="${opts.amount ?? ""}" autocomplete="off"
  ${page.suggested && page.suggested.length ? "" : "autofocus"}>
${when(
  page.amount_min || page.amount_max,
  () => html`<p class="hint">${page.amount_min ? html`From ${page.amount_min} ${unit}.` : ""}
${page.amount_max ? html` Up to ${page.amount_max} ${unit}.` : ""}</p>`
)}`
)}
<button type="submit">${page.cta_label}</button>
</form>

<p class="pay-footer muted">Paid in Monero, directly to the recipient's own wallet. Nothing holds
your funds in between.${when(back, () => html` <a href="${back}">Back to the site</a>`)}</p>
</div>`;

  return layout({
    title: page.title,
    body,
    chrome: "minimal",
    head: accent(page, opts.nonce),
    // A merchant's public page is the one thing here worth indexing.
    noIndex: false,
  });
}

/** Shown when a page is archived, closed, or was never there. */
export function renderPageGone(): string {
  return layout({
    title: "Not available",
    body: html`<h1>Not available</h1>
<p class="muted">This payment link is closed or does not exist.</p>`,
    chrome: "minimal",
  });
}

/** Shown when the pool is empty: a bounded, self-healing failure. */
export function renderPageBusy(page: PaymentPage, message: string, nonce = ""): string {
  return layout({
    title: page.title,
    body: html`<h1>${page.title}</h1>
<div class="banner warn">${message}</div>
<p><a class="button" href="/p/${page.slug}">Try again</a></p>`,
    chrome: "minimal",
    head: accent(page, nonce),
  });
}
