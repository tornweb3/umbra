// The console's payment-page management.
import type express from "express";
import { route, UUID_RE } from "../http.js";
import { merchantActionLimit } from "../limits.js";
import {
  archivePage,
  embedSnippets,
  CREATABLE_TYPES,
  createPage,
  listPages,
  PageInputError,
  pageById,
  updatePage,
  type PaymentPage,
} from "../pages.js";
import { SUPPORTED_CURRENCIES } from "../rates.js";
import { ensurePoolEnabled } from "../subaddresses.js";
import { timestamp, when } from "../ui/components.js";
import { html, type SafeHtml } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { portalNav } from "./nav.js";
import { portal, requireCsrf, requireSession } from "./session.js";

export interface PageRoutesOptions {
  baseUrl: string;
}

const TYPE_LABEL: Record<string, string> = {
  fixed: "Fixed price",
  donation: "Donation",
  tip: "Tip jar",
  crowdfund: "Crowdfunding",
};

function listView(pages: PaymentPage[], baseUrl: string, banner?: string): string {
  const body = html`<h1>Payment pages</h1>
<p class="muted">A link anyone can open and pay, with no account and no checkout to build. Each
payment mints its own subaddress, exactly like an API invoice.</p>
${when(banner, () => html`<div class="banner info">${banner}</div>`)}

${when(
  pages.length === 0,
  () => html`<div class="card">No pages yet.
<p><a class="button" href="/portal/pages/new">Create one</a></p></div>`
)}
${when(
  pages.length > 0,
  () => html`<table>
<thead><tr><th>Page</th><th>Type</th><th>Link</th><th>Created</th></tr></thead>
<tbody>${pages.map(
    (p) => html`<tr>
<td><a href="/portal/pages/${p.id}">${p.title}</a>${when(
      p.status === "archived",
      () => html` <span class="muted">(archived)</span>`
    )}</td>
<td>${TYPE_LABEL[p.page_type] ?? p.page_type}</td>
<td><a class="mono wrap" href="/p/${p.slug}">${baseUrl}/p/${p.slug}</a></td>
<td>${timestamp(p.created_at)}</td>
</tr>`
  )}</tbody></table>
<div class="pager"><a class="button" href="/portal/pages/new">New page</a></div>`
)}`;
  return layout({ title: "Payment pages", body, chrome: "portal", nav: portalNav("pages") });
}

function field(name: string, label: string, value: string, opts: { hint?: string; type?: string; attrs?: string } = {}): SafeHtml {
  return html`<label for="${name}">${label}</label>
<input id="${name}" name="${name}" type="${opts.type ?? "text"}" value="${value}" ${opts.attrs ? html`${opts.attrs}` : ""}>
${when(opts.hint, () => html`<p class="hint">${opts.hint}</p>`)}`;
}

function editView(
  opts: { baseUrl: string; csrf: string; page?: PaymentPage; error?: string; values?: Record<string, string> }
): string {
  const p = opts.page;
  const v = (key: string, fallback = "") => opts.values?.[key] ?? fallback;
  const editing = Boolean(p);
  const unit = v("price_currency", p?.price_currency ?? "");

  const body = html`<h1>${editing ? html`${p!.title}` : html`New payment page`}</h1>
${when(opts.error, () => html`<div class="banner error">${opts.error}</div>`)}
${when(
  editing,
  () => html`<div class="card left">
<h2>The link</h2>
<p class="addr mono">${opts.baseUrl}/p/${p!.slug}</p>
<p class="hint">Share it anywhere. <a href="/p/${p!.slug}">Open it</a> to see what a visitor sees.</p>
<h2>Paste into a website</h2>
<p class="addr mono">${embedSnippets(opts.baseUrl, p!).link}</p>
<p class="hint">That is the whole feature: an ordinary link. It needs no JavaScript and keeps
working if this gateway is ever down, which an embedded frame would not.</p>
<p class="hint">Optionally add this once, anywhere on the page, and the link opens in a small
window instead of navigating away. If it is blocked, the link simply navigates as before.</p>
<p class="addr mono">${embedSnippets(opts.baseUrl, p!).script}</p>
</div>`
)}

<form method="post" action="${editing ? `/portal/pages/${p!.id}` : "/portal/pages"}" class="card left">
<input type="hidden" name="_csrf" value="${opts.csrf}">

${when(
  !editing,
  () => html`<label for="page_type">Type</label>
<select id="page_type" name="page_type">
${CREATABLE_TYPES.map(
    (t) => html`<option value="${t}" ${v("page_type") === t ? "selected" : ""}>${TYPE_LABEL[t]}</option>`
  )}
</select>
<p class="hint">A fixed price charges one amount. A donation page or tip jar lets the visitor
choose. A crowdfunding page adds a goal and public progress.</p>`
)}

${field("title", "Title", v("title", p?.title ?? ""), { hint: "Shown at the top of the page and on the checkout." })}
<label for="description">Description</label>
<textarea id="description" name="description" rows="4">${v("description", p?.description ?? "")}</textarea>
<p class="hint">Plain text. Line breaks are kept.</p>

<label for="price_currency">Priced in</label>
<select id="price_currency" name="price_currency">
<option value="" ${unit === "" ? "selected" : ""}>XMR</option>
${SUPPORTED_CURRENCIES.map((c) => html`<option value="${c}" ${unit === c ? "selected" : ""}>${c}</option>`)}
</select>
<p class="hint">In a fiat currency, the rate is locked when the visitor commits, not when you
create the page.</p>

${field("amount_fixed", "Fixed amount", v("amount_fixed", p?.amount_fixed ?? ""), {
    hint: "For a fixed-price page. Leave empty for a donation or tip page.",
  })}
${field("suggested", "Suggested amounts", v("suggested", (p?.suggested ?? []).join(" ")), {
    hint: "Up to six, separated by spaces. They become one-click buttons.",
  })}
${field("amount_min", "Smallest allowed", v("amount_min", p?.amount_min ?? ""))}
${field("amount_max", "Largest allowed", v("amount_max", p?.amount_max ?? ""))}
${field("goal_amount", "Crowdfunding goal", v("goal_amount", p?.goal_amount ?? ""), {
    hint: "Only for a crowdfunding page. The page shows progress towards it.",
  })}
<label for="progress_visibility">Show progress as</label>
<select id="progress_visibility" name="progress_visibility">
${[
    ["public", "the amount raised and the goal"],
    ["percent_only", "a percentage only"],
    ["private", "not at all"],
  ].map(
    ([value, label]) =>
      html`<option value="${value}" ${(v("progress_visibility", p?.progress_visibility ?? "public")) === value ? "selected" : ""}>${label}</option>`
  )}
</select>
<p class="hint">Only confirmed payments are counted, and the supporter count is hidden until
there are at least five, because with a handful an individual amount can be worked out by
subtraction.</p>
${field("cta_label", "Button text", v("cta_label", p?.cta_label ?? "Pay with Monero"))}
${field("accent_color", "Accent colour", v("accent_color", p?.accent_color ?? ""), { hint: "#rrggbb, optional." })}
${field("return_url", "Return link", v("return_url", p?.return_url ?? ""), {
    type: "url",
    hint: "Where the visitor can get back to your site. Optional.",
  })}
${field("invoice_expiry_min", "Payment window (minutes)", v("invoice_expiry_min", String(p?.invoice_expiry_min ?? 30)), {
    type: "number",
    attrs: 'min="5" max="1440"',
  })}
<button type="submit">${editing ? "Save changes" : "Create page"}</button>
</form>

${when(
  editing,
  () => html`<form method="post" action="/portal/pages/${p!.id}/archive" class="card left">
<input type="hidden" name="_csrf" value="${opts.csrf}">
<input type="hidden" name="archived" value="${p!.status === "archived" ? "0" : "1"}">
<h2>${p!.status === "archived" ? "Reopen" : "Archive"}</h2>
<p class="hint">${p!.status === "archived"
      ? html`The link currently returns "not available". Reopening makes it payable again.`
      : html`The link stops accepting payments. Nothing is deleted: invoices keep pointing at it.`}</p>
<button class="secondary" type="submit">${p!.status === "archived" ? "Reopen the page" : "Archive the page"}</button>
</form>`
)}
<p><a href="/portal/pages">Back to pages</a></p>`;
  return layout({
    title: editing ? p!.title : "New payment page",
    body,
    chrome: "portal",
    nav: portalNav("pages"),
  });
}

export function mountPortalPageRoutes(app: express.Express, opts: PageRoutesOptions): void {
  const session = requireSession();
  const csrf = requireCsrf(opts.baseUrl);

  app.get("/portal/pages", session, route(async (req, res) => {
    res.send(listView(await listPages(portal(req).merchant.id), opts.baseUrl));
  }));

  app.get("/portal/pages/new", session, (req, res) => {
    res.send(editView({ baseUrl: opts.baseUrl, csrf: portal(req).csrf }));
  });

  app.post("/portal/pages", session, csrf, merchantActionLimit, route(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    try {
      const page = await createPage(portal(req).merchant.id, body);
      // Visitors mint from this, so the merchant needs a pool now.
      await ensurePoolEnabled(portal(req).merchant.id);
      res.redirect(303, `/portal/pages/${page.id}`);
    } catch (e: any) {
      if (e instanceof PageInputError) {
        return res.status(400).send(editView({ baseUrl: opts.baseUrl, csrf: portal(req).csrf, error: e.message, values: body }));
      }
      throw e;
    }
  }));

  app.get("/portal/pages/:id", session, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send(listView([], opts.baseUrl, "No such page."));
    const page = await pageById(portal(req).merchant.id, req.params.id);
    if (!page) return res.status(404).send(listView(await listPages(portal(req).merchant.id), opts.baseUrl, "No such page."));
    res.send(editView({ baseUrl: opts.baseUrl, csrf: portal(req).csrf, page }));
  }));

  app.post("/portal/pages/:id", session, csrf, merchantActionLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send(renderMissing(opts.baseUrl));
    const body = (req.body ?? {}) as Record<string, string>;
    try {
      const page = await updatePage(portal(req).merchant.id, req.params.id, body);
      if (!page) return res.status(404).send(renderMissing(opts.baseUrl));
      res.redirect(303, `/portal/pages/${page.id}`);
    } catch (e: any) {
      if (e instanceof PageInputError) {
        const page = await pageById(portal(req).merchant.id, req.params.id);
        return res
          .status(400)
          .send(editView({ baseUrl: opts.baseUrl, csrf: portal(req).csrf, page: page ?? undefined, error: e.message, values: body }));
      }
      throw e;
    }
  }));

  app.post("/portal/pages/:id/archive", session, csrf, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send(renderMissing(opts.baseUrl));
    const archived = String((req.body as any)?.archived ?? "1") === "1";
    const ok = await archivePage(portal(req).merchant.id, req.params.id, archived);
    if (!ok) return res.status(404).send(renderMissing(opts.baseUrl));
    res.redirect(303, `/portal/pages/${req.params.id}`);
  }));
}

function renderMissing(baseUrl: string): string {
  return listView([], baseUrl, "No such page.");
}
