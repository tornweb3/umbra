// One document shell and one stylesheet for every page the gateway serves.
// Before this, the checkout page and the two Shopify buyer pages each carried
// their own copy of the same inline CSS.
import { createHash } from "node:crypto";
import type express from "express";
import { html, raw, SafeHtml } from "./html.js";
import { CHECKOUT_JS } from "./scripts.js";

export const CSS = `
:root { --ink:#1b1b1b; --muted:#666; --line:#e4e2dd; --paper:#fff; --soft:#f4f4f4; --accent:#b4552d; }
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; color: var(--ink); background: var(--paper); margin: 0; line-height: 1.5; }
a { color: inherit; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* Buyer-facing pages: one narrow centred column, as the checkout page has
   always looked. Kept identical so moving it here is not a visual change. */
body.u-minimal { max-width: 560px; margin: 40px auto; padding: 0 16px; text-align: center; }
body.u-minimal form { max-width: 280px; margin: 22px auto 0; }
body.u-minimal label { text-align: left; }
body.u-minimal button { width: 100%; margin-top: 12px; }
.err { color: #a34d2d; }
.left { text-align: left; }
.tabs { display: flex; justify-content: center; gap: 24px; font-size: 14px; padding: 14px 0; }
.tabs a { color: var(--muted); text-decoration: none; }
.tabs a[aria-current="page"] { color: var(--ink); font-weight: 600; }

/* Merchant portal: a header strip and a wider column. */
body.u-portal { background: #faf9f7; }
.u-portal .bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; background: var(--paper); border-bottom: 1px solid var(--line); }
.u-portal .bar .wordmark { font-weight: 700; letter-spacing: -.02em; text-decoration: none; }
.u-portal .bar nav { display: flex; flex-wrap: wrap; gap: 16px; font-size: 14px; }
.u-portal .bar nav a { color: var(--muted); text-decoration: none; }
.u-portal .bar nav a:hover, .u-portal .bar nav a[aria-current="page"] { color: var(--ink); }
.u-portal main { max-width: 960px; margin: 0 auto; padding: 24px 20px 64px; }
.u-portal h1 { font-size: 24px; margin: 0 0 4px; }
.u-portal h2 { font-size: 17px; margin: 32px 0 10px; }

/* Shared pieces. */
.addr { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: var(--soft); padding: 10px; border-radius: 6px; }
.status { font-weight: bold; padding: 8px 16px; border-radius: 6px; display: inline-block; margin-top: 12px; }
.pending { background: #fff3cd; } .detected { background: #cfe2ff; }
.confirmed { background: #d1e7dd; } .expired { background: #f8d7da; } .unknown { background: var(--soft); }
#countdown { color: var(--muted); font-size: 14px; margin-top: 8px; }

.card { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
.banner { border: 1px solid var(--line); border-left-width: 4px; border-radius: 6px; padding: 12px 14px; margin-bottom: 14px; font-size: 14px; text-align: left; }
.banner.info { border-left-color: #6c8ebf; background: #f3f7fc; }
.banner.warn { border-left-color: #d9a406; background: #fffaf0; }
.banner.error { border-left-color: #c0392b; background: #fdf3f2; }

table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }

label { display: block; font-size: 13px; margin: 14px 0 4px; }
input, select, textarea { font: inherit; font-size: 16px; width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper); color: inherit; }
.hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
button, .button { font: inherit; font-size: 15px; padding: 10px 18px; border: 0; border-radius: 6px; background: var(--ink); color: #fff; cursor: pointer; text-decoration: none; display: inline-block; }
button.secondary { background: var(--paper); color: var(--ink); border: 1px solid var(--line); }
button:disabled { opacity: .5; cursor: default; }
`.trim();

const ASSETS: Record<string, { body: string; type: string }> = {
  "umbra.css": { body: CSS, type: "text/css; charset=utf-8" },
  "checkout.js": { body: CHECKOUT_JS, type: "text/javascript; charset=utf-8" },
};

/** Content-addressed so a deploy busts the cache and nothing else does. */
const etags = new Map<string, string>(
  Object.entries(ASSETS).map(([name, a]) => [name, `"${createHash("sha256").update(a.body).digest("hex").slice(0, 16)}"`])
);

export function assetUrl(name: keyof typeof ASSETS | string): string {
  return `/assets/${name}`;
}

/**
 * Serve the generated assets.
 *
 * Mounted before express.static on purpose: a file dropped into public/assets
 * would otherwise shadow these and be very confusing to debug.
 */
export function mountAssetRoutes(app: express.Express): void {
  app.get("/assets/:name", (req, res, next) => {
    const asset = ASSETS[req.params.name];
    const etag = etags.get(req.params.name);
    if (!asset || !etag) return next();
    res.setHeader("Content-Type", asset.type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.send(asset.body);
  });
}

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  /** "minimal" for buyer pages, "portal" for the merchant UI. */
  chrome?: "minimal" | "portal";
  /** Already-safe extra <head> content. */
  head?: SafeHtml;
  /** Asset names to load as deferred scripts, e.g. ["checkout.js"]. */
  scripts?: readonly string[];
  /** Portal chrome only: the nav row. */
  nav?: SafeHtml;
  /**
   * Keep the page out of search results. On by default: everything the
   * gateway serves is either a capability URL or a merchant's own console.
   */
  noIndex?: boolean;
}

export function layout(opts: LayoutOptions): string {
  const chrome = opts.chrome ?? "minimal";
  const noIndex = opts.noIndex ?? true;
  const scripts = (opts.scripts ?? []).map((name) => html`<script src="${assetUrl(name)}" defer></script>`);
  const bar =
    chrome === "portal"
      ? html`<div class="bar"><a class="wordmark" href="/portal">umbra</a><nav>${opts.nav ?? ""}</nav></div>`
      : html``;
  const main = chrome === "portal" ? html`<main>${opts.body}</main>` : opts.body;
  return `<!doctype html>
${html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title}</title>
${noIndex ? raw('<meta name="robots" content="noindex,nofollow">') : ""}
<link rel="icon" href="/icon.svg">
<link rel="stylesheet" href="${assetUrl("umbra.css")}">
${opts.head ?? ""}${scripts}</head>
<body class="u-${chrome}">
${bar}${main}
</body></html>`}`;
}
