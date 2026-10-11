// Payment pages: validation, slugs, mint tickets, amount resolution.
// No HTTP in here, so all of it is testable without a server.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { derivedSecret } from "./crypto.js";
import { query } from "./db.js";
import { isSupportedCurrency, SUPPORTED_CURRENCIES } from "./rates.js";
import { atomicFromXmr } from "./money.js";

export class PageInputError extends Error {}
/** The page exists but will not mint right now. Routes answer 503. */
export class PageBusyError extends Error {}

export const PAGE_TYPES = ["fixed", "donation", "tip", "crowdfund"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const CREATABLE_TYPES: PageType[] = ["fixed", "donation", "tip", "crowdfund"];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const RESERVED = new Set(["new", "api", "embed", "assets", "portal", "checkout", "healthz", "shopify", "p", "pos"]);

export interface PaymentPage {
  id: string;
  merchant_id: string;
  slug: string;
  page_type: PageType;
  price_currency: string | null;
  amount_fixed: string | null;
  amount_min: string | null;
  amount_max: string | null;
  suggested: string[] | null;
  goal_amount: string | null;
  raised_confirmed: string;
  supporter_count: number;
  progress_at: string | null;
  goal_reached_at: string | null;
  progress_visibility: "public" | "percent_only" | "private";
  title: string;
  description: string;
  cta_label: string;
  success_message: string;
  accent_color: string | null;
  return_url: string | null;
  status: "active" | "archived";
  closes_at: string | null;
  invoice_expiry_min: number;
  max_live_invoices: number;
  created_at: string;
}

const COLUMNS = `id, merchant_id, slug, page_type, price_currency, amount_fixed, amount_min, amount_max,
  suggested, goal_amount, raised_confirmed, supporter_count, progress_at, goal_reached_at,
  progress_visibility, title, description,
  cta_label, success_message, accent_color, return_url, status, closes_at, invoice_expiry_min,
  max_live_invoices, created_at`;

// ---- slugs -----------------------------------------------------------------

/**
 * A readable stem from the title plus six random characters.
 *
 * The random part is what makes a globally unique namespace workable: nobody
 * has to lose a race for "donate", and a page URL is not guessable from a
 * merchant's name.
 */
export function slugify(title: string): string {
  const stem = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const suffix = randomBytes(4).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  const slug = `${stem || "pay"}-${suffix.padEnd(6, "x")}`;
  return slug.length > 64 ? slug.slice(slug.length - 64) : slug;
}

export function slugComplaint(slug: unknown): string | null {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return "A link can use lowercase letters, numbers and hyphens, 3 to 64 characters.";
  }
  if (RESERVED.has(slug)) return "That link is reserved. Choose another.";
  return null;
}

// ---- mint tickets ----------------------------------------------------------

const TICKET_SECRET = derivedSecret("page-ticket");
const TICKET_MAX_AGE_MS = 60 * 60_000;
/** Faster than a human could read the page and choose an amount. */
const TICKET_MIN_AGE_MS = 750;

/**
 * A token the page hands to its own form.
 *
 * Not a strong control, and not pretending to be: an attacker can fetch a
 * fresh page for every mint. It costs them a page fetch per mint, which is
 * cached and cheap, and it removes the trivial curl loop. A captcha would be
 * the usual answer and is refused: it means a third-party surveillance script
 * on the donation page of a privacy product.
 */
export function issueTicket(slug: string, now = Date.now()): string {
  const payload = `${slug}.${now}`;
  const mac = createHmac("sha256", TICKET_SECRET).update(payload).digest("base64url").slice(0, 32);
  return `${now}.${mac}`;
}

export function ticketComplaint(slug: string, ticket: unknown, now = Date.now()): string | null {
  if (typeof ticket !== "string" || !ticket.includes(".")) return "This page expired. Reload it and try again.";
  const [issuedRaw, mac] = ticket.split(".", 2);
  const issued = Number(issuedRaw);
  if (!Number.isFinite(issued)) return "This page expired. Reload it and try again.";
  const expected = createHmac("sha256", TICKET_SECRET).update(`${slug}.${issued}`).digest("base64url").slice(0, 32);
  const a = Buffer.from(mac ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "This page expired. Reload it and try again.";
  const age = now - issued;
  if (age > TICKET_MAX_AGE_MS) return "This page expired. Reload it and try again.";
  if (age < TICKET_MIN_AGE_MS) return "That was too quick. Try again.";
  return null;
}

// ---- reading ---------------------------------------------------------------

/**
 * numeric(24,12) comes back from Postgres fully padded, so 0.01 arrives as
 * "0.010000000000". Correct, and unreadable on a page a stranger is looking
 * at, so the padding is trimmed once here rather than at each display site.
 */
export function trimAmount(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

const MONEY_FIELDS = ["amount_fixed", "amount_min", "amount_max", "goal_amount", "raised_confirmed"] as const;

function hydrate(row: any): PaymentPage {
  const out: any = { ...row, suggested: row.suggested ?? null };
  for (const field of MONEY_FIELDS) out[field] = trimAmount(out[field] ?? null);
  // raised_confirmed is NOT NULL in the schema, so keep it a string.
  out.raised_confirmed = out.raised_confirmed ?? "0";
  return out as PaymentPage;
}

export async function pageBySlug(slug: string): Promise<PaymentPage | null> {
  const { rows } = await query(`SELECT ${COLUMNS} FROM payment_pages WHERE slug = $1`, [slug]);
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function pageById(merchantId: string, id: string): Promise<PaymentPage | null> {
  const { rows } = await query(`SELECT ${COLUMNS} FROM payment_pages WHERE id = $1 AND merchant_id = $2`, [
    id,
    merchantId,
  ]);
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function listPages(merchantId: string): Promise<PaymentPage[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM payment_pages WHERE merchant_id = $1 ORDER BY status, created_at DESC`,
    [merchantId]
  );
  return rows.map(hydrate);
}

/** A page is payable only while it is active and before any deadline. */
export function payable(page: PaymentPage, now = new Date()): boolean {
  if (page.status !== "active") return false;
  if (page.closes_at && new Date(page.closes_at) <= now) return false;
  return true;
}

// ---- writing ---------------------------------------------------------------

export interface PageInput {
  page_type?: unknown;
  title?: unknown;
  description?: unknown;
  slug?: unknown;
  price_currency?: unknown;
  amount_fixed?: unknown;
  amount_min?: unknown;
  amount_max?: unknown;
  suggested?: unknown;
  goal_amount?: unknown;
  cta_label?: unknown;
  success_message?: unknown;
  accent_color?: unknown;
  return_url?: unknown;
  closes_at?: unknown;
  invoice_expiry_min?: unknown;
  progress_visibility?: unknown;
}

const DECIMAL_RE = /^\d{1,12}(\.\d{1,12})?$/;

function amount(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new PageInputError(`${field} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!DECIMAL_RE.test(text) || Number(text) <= 0) throw new PageInputError(`${field} must be a positive amount`);
  return text;
}

/** Validate and normalise everything a page needs. Throws PageInputError. */
export function normalisePage(input: PageInput, creating: boolean): Record<string, unknown> {
  const type = String(input.page_type ?? "donation") as PageType;
  if (creating && !CREATABLE_TYPES.includes(type)) {
    throw new PageInputError(`page_type must be one of: ${CREATABLE_TYPES.join(", ")}`);
  }

  const title = String(input.title ?? "").trim();
  if (!title || title.length > 200) throw new PageInputError("title must be 1 to 200 characters");

  const description = String(input.description ?? "").trim();
  if (description.length > 4000) throw new PageInputError("description must be at most 4000 characters");

  let currency: string | null = null;
  if (input.price_currency !== undefined && input.price_currency !== null && input.price_currency !== "") {
    currency = String(input.price_currency).toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new PageInputError(`price_currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
    }
  }

  const fixed = amount(input.amount_fixed, "amount_fixed", type === "fixed");
  const min = amount(input.amount_min, "amount_min");
  const max = amount(input.amount_max, "amount_max");
  if (min && max && Number(max) < Number(min)) throw new PageInputError("amount_max must not be below amount_min");
  const goal = amount(input.goal_amount, "goal_amount", type === "crowdfund");

  let suggested: string[] | null = null;
  if (input.suggested !== undefined && input.suggested !== null && input.suggested !== "") {
    const raw = Array.isArray(input.suggested)
      ? input.suggested
      : String(input.suggested)
          .split(/[,\s]+/)
          .filter(Boolean);
    if (raw.length > 6) throw new PageInputError("at most 6 suggested amounts");
    suggested = raw.map((v) => amount(v, "suggested")!) as string[];
    if (!suggested.length) suggested = null;
  }

  const accent = input.accent_color ? String(input.accent_color).trim() : null;
  if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) throw new PageInputError("accent_color must be a #rrggbb colour");

  let returnUrl: string | null = null;
  if (input.return_url !== undefined && input.return_url !== null && input.return_url !== "") {
    returnUrl = String(input.return_url).trim();
    if (!/^https?:\/\//.test(returnUrl) || returnUrl.length > 2000) {
      throw new PageInputError("return_url must be an http(s) URL");
    }
  }

  const expiry = input.invoice_expiry_min === undefined || input.invoice_expiry_min === "" ? 30 : Number(input.invoice_expiry_min);
  if (!Number.isInteger(expiry) || expiry < 5 || expiry > 1440) {
    throw new PageInputError("invoice_expiry_min must be an integer between 5 and 1440");
  }

  let closesAt: string | null = null;
  if (input.closes_at !== undefined && input.closes_at !== null && input.closes_at !== "") {
    const when = new Date(String(input.closes_at));
    if (Number.isNaN(when.getTime())) throw new PageInputError("closes_at must be a date");
    closesAt = when.toISOString();
  }

  const visibility = String(input.progress_visibility ?? "public");
  if (!["public", "percent_only", "private"].includes(visibility)) {
    throw new PageInputError("progress_visibility must be public, percent_only or private");
  }

  return {
    page_type: type,
    title,
    description,
    price_currency: currency,
    amount_fixed: fixed,
    amount_min: min,
    amount_max: max,
    suggested: suggested ? JSON.stringify(suggested) : null,
    goal_amount: goal,
    cta_label: String(input.cta_label ?? "").trim() || "Pay with Monero",
    success_message: String(input.success_message ?? "").trim().slice(0, 500),
    accent_color: accent,
    return_url: returnUrl,
    invoice_expiry_min: expiry,
    closes_at: closesAt,
    progress_visibility: visibility,
  };
}

export async function createPage(merchantId: string, input: PageInput): Promise<PaymentPage> {
  const fields = normalisePage(input, true);
  let slug: string;
  if (input.slug !== undefined && input.slug !== null && input.slug !== "") {
    const complaint = slugComplaint(String(input.slug));
    if (complaint) throw new PageInputError(complaint);
    slug = String(input.slug);
  } else {
    slug = slugify(fields.title as string);
  }

  try {
    const { rows } = await query(
      `INSERT INTO payment_pages
         (merchant_id, slug, page_type, price_currency, amount_fixed, amount_min, amount_max, suggested,
          goal_amount, title, description, cta_label, success_message, accent_color, return_url,
          invoice_expiry_min, closes_at, progress_visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING ${COLUMNS}`,
      [
        merchantId,
        slug,
        fields.page_type,
        fields.price_currency,
        fields.amount_fixed,
        fields.amount_min,
        fields.amount_max,
        fields.suggested,
        fields.goal_amount,
        fields.title,
        fields.description,
        fields.cta_label,
        fields.success_message,
        fields.accent_color,
        fields.return_url,
        fields.invoice_expiry_min,
        fields.closes_at,
        fields.progress_visibility,
      ]
    );
    return hydrate(rows[0]);
  } catch (e: any) {
    if (String(e?.code) === "23505") throw new PageInputError("That link is already taken. Choose another.");
    throw e;
  }
}

export async function updatePage(merchantId: string, id: string, input: PageInput): Promise<PaymentPage | null> {
  const existing = await pageById(merchantId, id);
  if (!existing) return null;
  const fields = normalisePage({ page_type: existing.page_type, ...input }, false);
  const { rows } = await query(
    `UPDATE payment_pages SET
       price_currency = $3, amount_fixed = $4, amount_min = $5, amount_max = $6, suggested = $7,
       goal_amount = $8, title = $9, description = $10, cta_label = $11, success_message = $12,
       accent_color = $13, return_url = $14, invoice_expiry_min = $15, closes_at = $16,
       progress_visibility = $17, updated_at = now()
     WHERE id = $1 AND merchant_id = $2 RETURNING ${COLUMNS}`,
    [
      id,
      merchantId,
      fields.price_currency,
      fields.amount_fixed,
      fields.amount_min,
      fields.amount_max,
      fields.suggested,
      fields.goal_amount,
      fields.title,
      fields.description,
      fields.cta_label,
      fields.success_message,
      fields.accent_color,
      fields.return_url,
      fields.invoice_expiry_min,
      fields.closes_at,
      fields.progress_visibility,
    ]
  );
  return rows[0] ? hydrate(rows[0]) : null;
}

/**
 * Archive rather than delete.
 *
 * Invoices reference the page, and the history of what someone paid for is
 * worth more than a tidy table.
 */
export async function archivePage(merchantId: string, id: string, archived = true): Promise<boolean> {
  const { rowCount } = await query(`UPDATE payment_pages SET status = $3, updated_at = now() WHERE id = $1 AND merchant_id = $2`, [
    id,
    merchantId,
    archived ? "archived" : "active",
  ]);
  return Boolean(rowCount);
}

// ---- minting ---------------------------------------------------------------

export interface ResolvedAmount {
  /** For createInvoice: one of these is set, never both. */
  amount_xmr?: string;
  price_amount?: string;
  price_currency?: string;
  tipAtomic: bigint;
}

/**
 * Work out what the visitor is paying, in the page's own unit.
 *
 * `amount` is what they chose; `tip` is an extra on top for a page that asks
 * for one. A fixed page ignores both.
 */
export function resolveAmount(page: PaymentPage, chosen: unknown, tip: unknown = null): ResolvedAmount {
  const unit = page.price_currency ? page.price_currency : "XMR";
  let value: string;

  if (page.page_type === "fixed") {
    value = page.amount_fixed!;
  } else {
    if (chosen === undefined || chosen === null || String(chosen).trim() === "") {
      throw new PageInputError(`Choose an amount in ${unit}.`);
    }
    const text = String(chosen).trim().replace(/,/g, "");
    if (!DECIMAL_RE.test(text) || Number(text) <= 0) throw new PageInputError(`That is not an amount in ${unit}.`);
    if (page.amount_min && Number(text) < Number(page.amount_min)) {
      throw new PageInputError(`The smallest amount is ${page.amount_min} ${unit}.`);
    }
    if (page.amount_max && Number(text) > Number(page.amount_max)) {
      throw new PageInputError(`The largest amount is ${page.amount_max} ${unit}.`);
    }
    value = text;
  }

  let total = value;
  let tipAtomic = 0n;
  if (tip !== undefined && tip !== null && String(tip).trim() !== "") {
    const tipText = String(tip).trim();
    if (!DECIMAL_RE.test(tipText) || Number(tipText) < 0) throw new PageInputError("That is not a tip amount.");
    if (Number(tipText) > 0) {
      // Sum as decimal strings scaled to 12 places, so no float touches money.
      const scale = (v: string) => BigInt(Math.round(Number(v) * 1e12));
      const sum = scale(value) + scale(tipText);
      total = (Number(sum) / 1e12).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
      tipAtomic = page.price_currency ? 0n : scale(tipText);
    }
  }

  if (page.price_currency) {
    return { price_amount: total, price_currency: page.price_currency, tipAtomic };
  }
  // Validate it as XMR now rather than discovering it inside createInvoice.
  atomicFromXmr(total);
  return { amount_xmr: total, tipAtomic };
}

/** The durable per-page cap: how many of its invoices are live and unpaid. */
export async function assertPageHasRoom(page: PaymentPage): Promise<void> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM invoices WHERE payment_page_id = $1 AND status = 'pending'`,
    [page.id]
  );
  if (Number(rows[0].n) >= page.max_live_invoices) {
    throw new PageBusyError("This page has too many unfinished payments right now. Try again in a few minutes.");
  }
}

export interface EmbedSnippets {
  /** The whole feature: a link. Works everywhere, needs nothing. */
  link: string;
  /** Optional enhancement: the same link, opened as a popup. */
  script: string;
}

/**
 * What a merchant pastes into their own site.
 *
 * A link, not an iframe: the payment page shows an address the visitor is
 * about to send irreversible money to, and inside a frame they cannot see
 * which origin produced it.
 */
export function embedSnippets(baseUrl: string, page: PaymentPage): EmbedSnippets {
  const url = `${baseUrl}/p/${page.slug}`;
  return {
    link: `<a href="${url}">${page.cta_label}</a>`,
    script: `<script src="${baseUrl}/embed/v1.js" async></script>`,
  };
}

// ---- crowdfunding progress -------------------------------------------------

export interface Progress {
  goal: string | null;
  raised: string;
  percent: number;
  supporters: number;
  goal_reached: boolean;
  as_of: string | null;
}

/**
 * Recompute one page's public total from the invoices behind it.
 *
 * Two decisions carry all the weight here.
 *
 * Only **confirmed** payments count. That is the whole answer to what a
 * dropped 0-conf payment does to a public figure: nothing, because it was
 * never in it. A public number that can fall looks like fraud, and the size of
 * the fall would publish the exact amount of the dropped transaction.
 *
 * A fiat page values each payment at **its own invoice's locked rate**, not at
 * today's rate. Re-valuing accumulated XMR every minute would make the total
 * wander with the market and let it fall while nothing was refunded.
 */
export async function recomputeProgress(pageId: string): Promise<void> {
  const { rows: pages } = await query<{ merchant_id: string; fiat: boolean; goal_amount: string | null }>(
    `SELECT merchant_id, (price_currency IS NOT NULL) AS fiat, goal_amount FROM payment_pages WHERE id = $1`,
    [pageId]
  );
  const page = pages[0];
  if (!page) return;

  const { rows } = await query<{ raised: string; supporters: string }>(
    `SELECT COALESCE(SUM(
              CASE WHEN $2::boolean THEN p.amount_atomic::numeric * i.rate / 1e12
                   ELSE p.amount_atomic::numeric / 1e12 END), 0)::text AS raised,
            count(DISTINCT i.id)::text AS supporters
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     WHERE i.payment_page_id = $1
       AND i.merchant_id = $3
       AND p.confirmed_at IS NOT NULL`,
    [pageId, page.fiat, page.merchant_id]
  );

  const raised = rows[0]?.raised ?? "0";
  const supporters = Number(rows[0]?.supporters ?? 0);

  await query(
    `UPDATE payment_pages
     SET raised_confirmed = $2, supporter_count = $3, progress_at = now()
     WHERE id = $1`,
    [pageId, raised, supporters]
  );

  // Exactly once, and decided by the recompute rather than by the cache.
  if (page.goal_amount && Number(raised) >= Number(page.goal_amount)) {
    const { rows: crossed } = await query<{ id: string }>(
      `UPDATE payment_pages SET goal_reached_at = now()
       WHERE id = $1 AND goal_reached_at IS NULL AND goal_amount IS NOT NULL AND $2::numeric >= goal_amount
       RETURNING id`,
      [pageId, raised]
    );
    if (crossed.length) console.log(`page ${pageId}: goal reached (${raised})`);
  }
}

/** Every page with a goal that is still open. Called by the worker. */
export async function refreshAllProgress(): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM payment_pages
     WHERE goal_amount IS NOT NULL AND status = 'active'
       AND (closes_at IS NULL OR closes_at > now())`
  );
  for (const r of rows) await recomputeProgress(r.id);
}

/** What anyone may see. Shaped by the page's own visibility setting. */
export function publicProgress(page: PaymentPage): Progress {
  const goal = page.goal_amount;
  const raised = trimAmount(page.raised_confirmed) ?? "0";
  const percent = goal && Number(goal) > 0 ? Math.min(100, Math.round((Number(raised) / Number(goal)) * 100)) : 0;
  const hidden = page.progress_visibility === "private";
  const amounts = page.progress_visibility === "public";
  return {
    goal: hidden ? null : goal,
    raised: amounts ? raised : "",
    percent: hidden ? 0 : percent,
    // Suppressed while the number is small: with a handful of supporters an
    // individual amount can be recovered by subtraction.
    supporters: amounts && page.supporter_count >= 5 ? page.supporter_count : 0,
    goal_reached: !hidden && Boolean(goal) && Number(raised) >= Number(goal),
    as_of: hidden ? null : page.progress_at ?? null,
  };
}
