// Small pieces shared by the buyer-facing pages and the merchant portal.
import { html, SafeHtml } from "./html.js";

/** The four invoice statuses, as a badge. Anything else renders unstyled. */
const KNOWN_STATUSES = new Set(["pending", "detected", "confirmed", "expired"]);

export function statusBadge(status: string, suffix = ""): SafeHtml {
  const cls = KNOWN_STATUSES.has(status) ? status : "unknown";
  return html`<span id="status" class="status ${cls}">${status}${suffix}</span>`;
}

/** Render `body` only when `cond` holds. Keeps templates free of ternaries. */
export function when(cond: unknown, body: SafeHtml | (() => SafeHtml)): SafeHtml {
  if (!cond) return html``;
  return typeof body === "function" ? body() : body;
}

/**
 * A timestamp the browser localises, with the ISO value kept in the markup so
 * it stays readable without JavaScript and sortable to a machine.
 */
export function timestamp(value: Date | string | null | undefined): SafeHtml {
  if (!value) return html`<span class="muted">never</span>`;
  const iso = value instanceof Date ? value.toISOString() : String(value);
  return html`<time datetime="${iso}">${iso.replace("T", " ").replace(/\.\d+Z$/, "Z")}</time>`;
}
