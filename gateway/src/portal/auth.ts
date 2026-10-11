// Login, logout and the operator-driven password reset.
import type express from "express";
import { query } from "../db.js";
import { rateLimit } from "../security.js";
import { html } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { when } from "../ui/components.js";
import {
  authenticate,
  consumeResetToken,
  COOKIE_NAME,
  countPortalUsers,
  endAllSessions,
  MIN_PASSWORD_LENGTH,
  normaliseUsername,
  passwordComplaint,
  loadSession,
  setPassword,
  setSessionCookie,
  startSession,
} from "./session.js";
import { readCookie } from "../cookies.js";

export interface AuthOptions {
  baseUrl: string;
  network: string;
}

function loginPage(opts: AuthOptions, error = "", username = ""): string {
  const body = html`<h1>Umbra</h1>
<p class="muted">${opts.network === "mainnet" ? "Monero mainnet" : `Monero ${opts.network}`}</p>
${when(error, () => html`<div class="banner error">${error}</div>`)}
<form method="post" action="/portal/login">
<label for="username">Username</label>
<input id="username" name="username" required autocomplete="username" autofocus value="${username}">
<label for="password">Password</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">Log in</button>
</form>
<p class="muted">Lost the password? On the server: <span class="mono">npm run portal:reset -- &lt;username&gt;</span></p>`;
  return layout({ title: "Log in", body, chrome: "minimal" });
}

function resetPage(token: string, error = ""): string {
  const body = html`<h1>Set a new password</h1>
${when(error, () => html`<div class="banner error">${error}</div>`)}
<form method="post" action="/portal/reset">
<input type="hidden" name="token" value="${token}">
<label for="password">New password</label>
<input id="password" name="password" type="password" required autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}">
<label for="password2">Repeat password</label>
<input id="password2" name="password2" type="password" required autocomplete="new-password">
<button type="submit">Set password</button>
</form>`;
  return layout({ title: "Set a new password", body, chrome: "minimal" });
}

export function mountAuthRoutes(app: express.Express, opts: AuthOptions): void {
  // Per-IP, on top of the per-account lockout in authenticate(). This one
  // resets when the process restarts and an attacker rotating addresses walks
  // past it, which is exactly why the durable one lives in the database.
  const loginLimit = rateLimit({ windowMs: 900_000, max: 10, message: "too many attempts, wait a few minutes" });
  const resetLimit = rateLimit({ windowMs: 3_600_000, max: 10, message: "too many attempts" });

  app.get("/portal/login", loginLimit, async (req, res) => {
    // Nothing to log into yet: send a fresh install to setup instead.
    if ((await countPortalUsers()) === 0) return res.redirect(303, "/portal/setup");
    // Already logged in: do not make them type it again.
    const existing = readCookie(req, COOKIE_NAME);
    if (existing && (await loadSession(existing))) return res.redirect(303, "/portal");
    res.send(loginPage(opts));
  });

  app.post("/portal/login", loginLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const username = normaliseUsername(body.username);
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return res.status(400).send(loginPage(opts, "Enter a username and password.", username));

    const result = await authenticate(username, password);
    if (!result.ok) {
      // The same sentence either way: a different one for a locked account
      // would confirm the account exists.
      const message =
        result.reason === "locked"
          ? "Too many failed attempts. Try again later."
          : "Wrong username or password.";
      return res.status(401).send(loginPage(opts, message, username));
    }
    const session = await startSession(result.userId, req);
    setSessionCookie(req, res, opts.baseUrl, session.token, session.expiresAt);
    res.redirect(303, "/portal");
  });

  app.get("/portal/reset", resetLimit, (req, res) => {
    const token = String(req.query.token ?? "");
    if (!token) return res.status(400).send(resetPage("", "That link is incomplete."));
    res.send(resetPage(token));
  });

  app.post("/portal/reset", resetLimit, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const token = String(body.token ?? "");
    if (!token) return res.status(400).send(resetPage("", "That link is incomplete."));
    if (body.password !== body.password2) return res.status(400).send(resetPage(token, "The two passwords do not match."));

    // The username is only used to reject a password equal to it.
    const { rows } = await query<{ username: string }>(
      `SELECT username FROM portal_users WHERE reset_token_hash IS NOT NULL AND reset_expires_at > now()`
    );
    const complaint = passwordComplaint(body.password, rows[0]?.username ?? "");
    if (complaint) return res.status(400).send(resetPage(token, complaint));

    const userId = await consumeResetToken(token);
    if (!userId) return res.status(403).send(resetPage("", "That link has expired or was already used."));
    await setPassword(userId, body.password);
    // A reset is how someone recovers from a compromise, so every existing
    // session dies with it.
    await endAllSessions(userId);
    const session = await startSession(userId, req);
    setSessionCookie(req, res, opts.baseUrl, session.token, session.expiresAt);
    res.redirect(303, "/portal");
  });
}
