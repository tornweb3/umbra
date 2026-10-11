// First run: claiming a fresh gateway from a browser.
//
// Umbrel's app store standard is that an app must be understandable from the
// browser after install, with no SSH and no log scraping. That is this page.
// It is also the most dangerous page in the product, because whoever completes
// it owns the gateway, so the gate below is deliberately narrow.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type express from "express";
import { query } from "../db.js";
import { sha256Hex } from "../crypto.js";
import { readCookie } from "../cookies.js";
import { createMerchant } from "../merchants.js";
import { assertSafeWebhookUrl, isPrivateAddress, rateLimit, UnsafeUrlError } from "../security.js";
import { html } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { when } from "../ui/components.js";
import {
  countPortalUsers,
  createPortalUser,
  isSecureRequest,
  MIN_PASSWORD_LENGTH,
  normaliseUsername,
  passwordComplaint,
  setSessionCookie,
  startSession,
} from "./session.js";

export const SETUP_COOKIE = "umbra_setup";
const SIGNUP_TOKEN = process.env.SIGNUP_TOKEN ?? "";

const ADDRESS_PREFIX: Record<string, string> = { mainnet: "4", stagenet: "5", testnet: "9" };
const VIEW_KEY_RE = /^[0-9a-fA-F]{64}$/;
const API_KEY_RE = /^xmr_sk_[0-9a-f]{64}$/;

export interface SetupOptions {
  baseUrl: string;
  network: string;
}

function tokenMatches(given: string): boolean {
  if (!SIGNUP_TOKEN) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(SIGNUP_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who may claim an unclaimed gateway.
 *
 * The `trust proxy` clause carries the weight: behind nginx with TRUST_PROXY
 * unset, req.ip is 127.0.0.1 for every request on earth, so a naive
 * private-peer check would hand the gateway to the first stranger who loads
 * it. If the operator has configured a proxy, they are fronting this
 * deliberately and must supply the token.
 */
export function setupAllowed(app: express.Express, req: express.Request): boolean {
  const given = String(req.query.token ?? (req.body as any)?.token ?? "");
  if (tokenMatches(given)) return true;
  const trustsProxy = Boolean(app.get("trust proxy"));
  return !trustsProxy && isPrivateAddress(req.ip ?? "");
}

function plantNonce(res: express.Response, secure: boolean): string {
  const nonce = randomBytes(18).toString("base64url");
  // Double submit, because there is no session yet to hang a token on. CSRF
  // against this form means a stranger claims a freshly installed gateway.
  res.cookie(SETUP_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure, path: "/portal", maxAge: 3_600_000 });
  return nonce;
}

function nonceOk(req: express.Request): boolean {
  const cookie = readCookie(req, SETUP_COOKIE);
  const field = String((req.body as any)?._nonce ?? "");
  if (!cookie || !field) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(field);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Shown when setup is refused: a 200 status page, not a 403 JSON blob. */
function lockedPage(opts: SetupOptions, hasUsers: boolean): string {
  const body = html`<h1>Umbra is running</h1>
${when(
  hasUsers,
  () => html`<p>This gateway is already set up. <a href="/portal/login">Log in</a>.</p>`
)}
${when(
  !hasUsers,
  () => html`<p class="muted">Setup is not open from here, because this request did not come from the
machine the gateway is running on. Two ways forward:</p>
<div class="card left">
<p><strong>From the machine itself</strong>, open a tunnel and use that:</p>
<p class="addr">ssh -L 3000:127.0.0.1:3000 you@your-server</p>
<p>then open <span class="mono">http://127.0.0.1:3000</span>.</p>
</div>
<div class="card left">
<p><strong>Or open setup deliberately</strong>: set <span class="mono">SIGNUP_TOKEN</span> in
<span class="mono">.env</span>, restart the gateway, and open
<span class="mono">/portal/setup?token=&lt;your token&gt;</span>.</p>
</div>`
)}
<p class="muted"><a href="/healthz">Health</a></p>`;
  return layout({ title: "Umbra", body, chrome: "minimal" });
}

function setupForm(opts: SetupOptions, nonce: string, mode: "create" | "claim", error = "", values: Record<string, string> = {}): string {
  const prefix = ADDRESS_PREFIX[opts.network.toLowerCase()] ?? "4";
  const v = (k: string) => values[k] ?? "";
  const body = html`<h1>Set up Umbra</h1>
<p class="muted">This gateway has no account yet. It watches your wallet with a view key and never
holds a spend key.</p>
${when(error, () => html`<div class="banner error">${error}</div>`)}
<div class="tabs">
  <a href="/portal/setup?token=${v("token")}" aria-current="${mode === "create" ? "page" : "false"}">New account</a>
  <a href="/portal/setup?mode=claim&token=${v("token")}" aria-current="${mode === "claim" ? "page" : "false"}">I already have an API key</a>
</div>
${when(
  mode === "create",
  () => html`<form method="post" action="/portal/setup">
<input type="hidden" name="_nonce" value="${nonce}">
<input type="hidden" name="token" value="${v("token")}">
<label for="name">Shop name</label>
<input id="name" name="name" required maxlength="200" value="${v("name")}">
<label for="address">Your Monero address</label>
<input id="address" name="address" required pattern="${prefix}[0-9A-Za-z]{94}" value="${v("address")}">
<p class="hint">Your ${opts.network} primary address, starting with ${prefix}. Payments land here directly.</p>
<label for="view_key">Private view key</label>
<input id="view_key" name="view_key" required pattern="[0-9a-fA-F]{64}" value="${v("view_key")}">
<p class="hint">64 hex characters. Never your spend key: this gateway cannot move funds and should not be able to.</p>
<label for="webhook_url">Webhook URL (optional)</label>
<input id="webhook_url" name="webhook_url" type="url" value="${v("webhook_url")}">
<p class="hint">Where payment notifications go. Leave empty if you only use the hosted checkout page.</p>
<label for="username">Console username</label>
<input id="username" name="username" required autocomplete="username" value="${v("username")}">
<label for="password">Console password</label>
<input id="password" name="password" type="password" required autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}">
<label for="password2">Repeat password</label>
<input id="password2" name="password2" type="password" required autocomplete="new-password">
<p class="hint">This is for the console only. It is not your API key and not your wallet password.</p>
<button type="submit">Create account</button>
</form>`
)}
${when(
  mode === "claim",
  () => html`<form method="post" action="/portal/setup">
<input type="hidden" name="_nonce" value="${nonce}">
<input type="hidden" name="mode" value="claim">
<input type="hidden" name="token" value="${v("token")}">
<label for="api_key">API key</label>
<input id="api_key" name="api_key" required autocomplete="off" placeholder="xmr_sk_...">
<p class="hint">Proves the account is yours. It is used once, here, and not stored.</p>
<label for="username">Console username</label>
<input id="username" name="username" required autocomplete="username" value="${v("username")}">
<label for="password">Console password</label>
<input id="password" name="password" type="password" required autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}">
<label for="password2">Repeat password</label>
<input id="password2" name="password2" type="password" required autocomplete="new-password">
<button type="submit">Claim account</button>
</form>`
)}`;
  return layout({ title: "Set up Umbra", body, chrome: "minimal" });
}

/** Shown once, with the credentials that exist nowhere else. */
function credentialsPage(apiKey: string, webhookSecret: string): string {
  const body = html`<h1>Account created</h1>
<div class="banner warn">Copy these now. They are shown once and only a hash of the API key is stored,
so a lost key cannot be recovered, only rotated.</div>
<div class="card left">
<label>API key</label>
<p class="addr">${apiKey}</p>
<label>Webhook secret</label>
<p class="addr">${webhookSecret}</p>
</div>
<p class="muted">Your view-only wallet is being prepared in the background. Invoice creation will
answer 503 until it is ready, which usually takes a few minutes.</p>
<p><a class="button" href="/portal">I have copied them, continue</a></p>`;
  return layout({ title: "Account created", body, chrome: "minimal" });
}

export function mountSetupRoutes(app: express.Express, opts: SetupOptions): void {
  const setupLimit = rateLimit({ windowMs: 3_600_000, max: 20, message: "too many setup attempts" });

  app.get("/portal/setup", setupLimit, async (req, res) => {
    const users = await countPortalUsers();
    if (users > 0) return res.redirect(303, "/portal/login");
    if (!setupAllowed(app, req)) return res.status(200).send(lockedPage(opts, false));
    const nonce = plantNonce(res, isSecureRequest(req, opts.baseUrl));
    const mode = req.query.mode === "claim" ? "claim" : "create";
    res.send(setupForm(opts, nonce, mode, "", { token: String(req.query.token ?? "") }));
  });

  app.post("/portal/setup", setupLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const mode = body.mode === "claim" ? "claim" : "create";
    const users = await countPortalUsers();
    if (users > 0) return res.redirect(303, "/portal/login");
    if (!setupAllowed(app, req)) return res.status(403).send(lockedPage(opts, false));

    const keep = { token: body.token ?? "", name: body.name ?? "", address: body.address ?? "", view_key: body.view_key ?? "", webhook_url: body.webhook_url ?? "", username: body.username ?? "" };
    const fail = (message: string, status = 400) => {
      const nonce = plantNonce(res, isSecureRequest(req, opts.baseUrl));
      res.status(status).send(setupForm(opts, nonce, mode, message, keep));
    };

    if (!nonceOk(req)) return fail("That form expired. Try again.", 403);

    const username = normaliseUsername(body.username);
    if (!username || username.length > 200) return fail("Choose a console username.");
    if (body.password !== body.password2) return fail("The two passwords do not match.");
    const complaint = passwordComplaint(body.password, username);
    if (complaint) return fail(complaint);

    if (mode === "claim") {
      // The API key proves the account is theirs. It is matched by hash, used
      // once, and never stored anywhere by this flow.
      const key = String(body.api_key ?? "").trim();
      if (!API_KEY_RE.test(key)) return fail("That does not look like an Umbra API key.");
      const { rows } = await query<{ id: string }>(
        `SELECT m.id FROM merchants m
         LEFT JOIN portal_users u ON u.merchant_id = m.id
         WHERE m.api_key_hash = $1 AND u.id IS NULL`,
        [sha256Hex(key)]
      );
      if (!rows.length) return fail("No unclaimed account matches that key.", 403);
      const userId = await createPortalUser(rows[0].id, username, body.password);
      const session = await startSession(userId, req);
      setSessionCookie(req, res, opts.baseUrl, session.token, session.expiresAt);
      return res.redirect(303, "/portal");
    }

    const prefix = ADDRESS_PREFIX[opts.network.toLowerCase()];
    const address = String(body.address ?? "").trim();
    if (!prefix || !new RegExp(`^${prefix}[0-9A-Za-z]{94}$`).test(address))
      return fail(`That is not a ${opts.network} address (it should start with ${prefix} and be 95 characters).`);
    if (!VIEW_KEY_RE.test(String(body.view_key ?? "").trim()))
      return fail("The private view key should be 64 hex characters.");
    if (!body.name?.trim()) return fail("Give your shop a name.");

    const dup = await query(`SELECT 1 FROM merchants WHERE address = $1 LIMIT 1`, [address]);
    if (dup.rowCount) return fail("That address is already registered on this gateway.", 409);

    let webhookUrl: string | null = null;
    if (body.webhook_url?.trim()) {
      try {
        await assertSafeWebhookUrl(body.webhook_url.trim());
        webhookUrl = body.webhook_url.trim();
      } catch (e: any) {
        if (e instanceof UnsafeUrlError) return fail(e.message);
        throw e;
      }
    }

    const created = await createMerchant({
      name: body.name.trim(),
      address,
      view_key: String(body.view_key).trim(),
      webhook_url: webhookUrl,
    });
    const userId = await createPortalUser(created.id, username, body.password);
    const session = await startSession(userId, req);
    setSessionCookie(req, res, opts.baseUrl, session.token, session.expiresAt);
    // Rendered in the body of this POST: a redirect would put the key in a
    // query string, and a flash row would mean storing it.
    res.status(201).send(credentialsPage(created.apiKey, created.webhookSecret));
  });
}
