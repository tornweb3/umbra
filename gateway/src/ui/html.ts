// HTML built by a tagged template that escapes every interpolation, so the
// safe thing is the short thing. The pages here show buyers an address they
// are about to send irreversible money to; an injected script on one of them
// is a stolen payment, not a defaced page.
import { escapeHtml } from "../http.js";

/** A string that is already HTML and must not be escaped again. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Mark an already-safe fragment so `html` passes it through untouched. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

function interpolate(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  // JSX's convention: these render as nothing, so `cond && html`...`` works.
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(interpolate).join("");
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interpolate(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

const DEFAULT_SCHEMES = ["http:", "https:"] as const;

/**
 * Validate a URL for use in an href.
 *
 * Escaping makes a value safe as *text* and does nothing about the scheme:
 * `javascript:alert(1)` survives every escaper intact. Every attribute that
 * takes a merchant-, buyer- or platform-supplied URL goes through here, and
 * the caller decides what to do with a null.
 *
 * @param schemes absolute schemes to allow. Pass `["monero:"]` for a wallet URI.
 * @returns the URL to use, or null when it is not safe or not a URL at all.
 */
export function safeUrl(value: unknown, schemes: readonly string[] = DEFAULT_SCHEMES): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  // Browsers skip ASCII control characters while parsing a scheme, so
  // "java\tscript:alert(1)" executes. Nothing legitimate carries them.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  // Same-origin references have no scheme to check. "//host" is excluded: it
  // is scheme-relative and reaches another origin, so it goes through parsing.
  if (raw.startsWith("#") || raw.startsWith("?")) return raw;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  let parsed: URL;
  try {
    // The base only matters for genuinely relative input; it is never emitted.
    parsed = new URL(raw, "https://umbra.invalid");
  } catch {
    return null;
  }
  if (!schemes.includes(parsed.protocol)) return null;
  return raw;
}
