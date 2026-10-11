// The console's nav row. Its own module so the page modules and index.ts can
// share it without importing each other.
import { html, type SafeHtml } from "../ui/html.js";

const LINKS: Array<[key: string, href: string, label: string]> = [
  ["overview", "/portal", "Overview"],
  ["invoices", "/portal/invoices", "Invoices"],
  ["settings", "/portal/settings", "Settings"],
  ["status", "/portal/status", "Status"],
];

export function portalNav(active: string): SafeHtml {
  return html`${LINKS.map(
    ([key, href, label]) => html`<a href="${href}" aria-current="${key === active ? "page" : "false"}">${label}</a>`
  )}`;
}
