// Settings: the page where every dangerous button lives.
//
// Changing the webhook URL is the most valuable attack in the whole product:
// point deliveries at an attacker and every payment notification goes to them,
// and with a rotated secret they can forge events a shop will treat as paid.
// So nothing here can be done with a stolen session alone: the password is
// required again, and the window is ten minutes.
import type express from "express";
import { query } from "../db.js";
import { route } from "../http.js";
import { keyState, revokePreviousKey, rotateApiKey } from "../merchants.js";
import { newSecret } from "../crypto.js";
import { assertSafeWebhookUrl, rateLimit, serverError, UnsafeUrlError } from "../security.js";
import { timestamp, when } from "../ui/components.js";
import { html } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { portalNav } from "./nav.js";
import {
  confirmPassword,
  endOtherSessions,
  listSessions,
  markReauth,
  MIN_PASSWORD_LENGTH,
  passwordComplaint,
  portal,
  requireCsrf,
  requireRecentAuth,
  requireSession,
  setPassword,
  type SessionRow,
} from "./session.js";

export interface SettingsOptions {
  baseUrl: string;
}

const REAUTH_WINDOW_MS = 10 * 60_000;

function reauthFresh(reauthAt: string | null): boolean {
  return Boolean(reauthAt && Date.now() - new Date(reauthAt).getTime() < REAUTH_WINDOW_MS);
}

interface PageState {
  csrf: string;
  fresh: boolean;
  webhookUrl: string | null;
  key: Awaited<ReturnType<typeof keyState>>;
  sessions: SessionRow[];
  banner?: { kind: "info" | "warn" | "error"; text: string };
  /** A one-time secret, rendered in the body of the POST that created it. */
  reveal?: { label: string; value: string; note: string };
}

function settingsPage(state: PageState): string {
  const csrf = html`<input type="hidden" name="_csrf" value="${state.csrf}">`;
  const body = html`<h1>Settings</h1>

${when(state.banner, () => html`<div class="banner ${state.banner!.kind}">${state.banner!.text}</div>`)}

${when(
  state.reveal,
  () => html`<div class="card left">
<div class="banner warn">Copy this now. It is shown once and only a hash is stored.</div>
<label>${state.reveal!.label}</label>
<p class="addr">${state.reveal!.value}</p>
<p class="hint">${state.reveal!.note}</p>
</div>`
)}

${when(
  !state.fresh,
  () => html`<div class="card left">
<h2>Confirm your password</h2>
<p class="hint">Changing a credential needs your password again. Pointing webhooks somewhere new
is the most valuable thing an attacker could do with a stolen session, so this is deliberate.</p>
<form method="post" action="/portal/settings/confirm">
${csrf}
<label for="password">Password</label>
<input id="password" name="password" type="password" required autocomplete="current-password" autofocus>
<button type="submit">Confirm</button>
</form>
</div>`
)}

<div class="card left">
<h2>Webhook URL</h2>
<p class="hint">Where payment notifications are delivered, signed with your webhook secret.
${when(!state.webhookUrl, () => html`Currently unset, so nothing is delivered.`)}</p>
${when(
  state.fresh,
  () => html`<form method="post" action="/portal/settings/webhook">
${csrf}
<label for="webhook_url">URL</label>
<input id="webhook_url" name="webhook_url" type="url" value="${state.webhookUrl ?? ""}" placeholder="https://your-shop.example/umbra/webhook">
<p class="hint">Leave empty to stop delivering. It must not resolve to a private address.</p>
<button type="submit">Save</button>
</form>`
)}
${when(!state.fresh, () => html`<p class="mono">${state.webhookUrl ?? "none"}</p>`)}
</div>

<div class="card left">
<h2>Webhook secret</h2>
<p class="hint">Rotating it invalidates the old secret <strong>immediately</strong>, so update
your shop first. There is no overlap here: a signature either verifies or it does not.</p>
${when(
  state.fresh,
  () => html`<form method="post" action="/portal/settings/rotate-webhook-secret">
${csrf}<button class="secondary" type="submit">Rotate webhook secret</button>
</form>`
)}
</div>

<div class="card left">
<h2>API key</h2>
<table>
<tr><th>Current key issued</th><td>${timestamp(state.key.api_key_created_at)}</td></tr>
${when(
  state.key.has_previous,
  () => html`<tr><th>Previous key</th><td>still works until ${timestamp(state.key.prev_api_key_expires_at)}</td></tr>
<tr><th>Previous key last used</th><td>${state.key.prev_api_key_last_used_at ? timestamp(state.key.prev_api_key_last_used_at) : html`<span class="muted">not since rotation</span>`}</td></tr>`
)}
</table>
${when(
  state.key.has_previous,
  () => html`<div class="banner ${state.key.prev_api_key_last_used_at ? "warn" : "info"}">
${state.key.prev_api_key_last_used_at
    ? html`Something is still using the old key, last seen ${timestamp(state.key.prev_api_key_last_used_at)}.
Find it and paste the new key there before revoking.`
    : html`Nothing has used the old key since you rotated. Safe to revoke.`}
</div>
${when(
  state.fresh,
  () => html`<form method="post" action="/portal/settings/revoke-previous-key">
${csrf}<button class="secondary" type="submit">Revoke the previous key now</button>
</form>`
)}`
)}
${when(
  state.fresh,
  () => html`<form method="post" action="/portal/settings/rotate-api-key">
${csrf}
<label for="grace_minutes">Keep the old key working for</label>
<select id="grace_minutes" name="grace_minutes">
<option value="1440" selected>24 hours</option>
<option value="60">1 hour</option>
<option value="10080">7 days</option>
<option value="0">not at all, revoke it now</option>
</select>
<p class="hint">Rotating does not change your webhook secret, does not log you out, and does not
affect existing invoices or their checkout links.</p>
<button type="submit">Rotate API key</button>
</form>`
)}
</div>

<div class="card left">
<h2>Console password</h2>
${when(
  state.fresh,
  () => html`<form method="post" action="/portal/settings/password">
${csrf}
<label for="new_password">New password</label>
<input id="new_password" name="new_password" type="password" required autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}">
<label for="new_password2">Repeat</label>
<input id="new_password2" name="new_password2" type="password" required autocomplete="new-password">
<p class="hint">Changing it ends every other session.</p>
<button type="submit">Change password</button>
</form>`
)}
</div>

<div class="card left">
<h2>Sessions</h2>
<table>
<thead><tr><th>Started</th><th>Last used</th><th>Client</th><th></th></tr></thead>
<tbody>${state.sessions.map(
    (s) => html`<tr>
<td>${timestamp(s.created_at)}</td>
<td>${timestamp(s.last_seen_at)}</td>
<td class="wrap">${s.user_agent || html`<span class="muted">unknown</span>`}</td>
<td>${s.current ? html`<span class="muted">this one</span>` : ""}</td>
</tr>`
  )}</tbody>
</table>
${when(
  state.sessions.length > 1,
  () => html`<form method="post" action="/portal/settings/revoke-sessions">
${csrf}<button class="secondary" type="submit">Log out everywhere else</button>
</form>`
)}
</div>`;
  return layout({ title: "Settings", body, chrome: "portal", nav: portalNav("settings") });
}

async function loadState(req: express.Request, extra: Partial<PageState> = {}): Promise<PageState> {
  const p = portal(req);
  return {
    csrf: p.csrf,
    fresh: reauthFresh(p.reauthAt),
    webhookUrl: p.merchant.webhook_url,
    key: await keyState(p.merchant.id),
    sessions: await listSessions(p.userId, p.sessionId),
    ...extra,
  };
}

export function mountSettingsRoutes(app: express.Express, opts: SettingsOptions): void {
  const session = requireSession();
  const csrf = requireCsrf(opts.baseUrl);
  const recent = requireRecentAuth();
  // Behind a session already, so this is about slowing a stolen-laptop attempt
  // rather than an internet-wide one.
  const confirmLimit = rateLimit({ windowMs: 900_000, max: 10, key: (req) => portal(req).sessionId });
  const changeLimit = rateLimit({ windowMs: 3_600_000, max: 20, key: (req) => portal(req).merchant.id });

  app.get("/portal/settings", session, route(async (req, res) => {
    res.send(settingsPage(await loadState(req)));
  }));

  app.post("/portal/settings/confirm", session, csrf, confirmLimit, route(async (req, res) => {
    const password = String((req.body as any)?.password ?? "");
    const p = portal(req);
    if (!(await confirmPassword(p.userId, password))) {
      return res.status(401).send(
        settingsPage(await loadState(req, { banner: { kind: "error", text: "That password is not right." } }))
      );
    }
    await markReauth(p.sessionId);
    res.redirect(303, "/portal/settings");
  }));

  app.post("/portal/settings/webhook", session, csrf, recent, changeLimit, route(async (req, res) => {
    const raw = String((req.body as any)?.webhook_url ?? "").trim();
    const p = portal(req);
    if (raw) {
      try {
        await assertSafeWebhookUrl(raw);
      } catch (e: any) {
        if (e instanceof UnsafeUrlError) {
          return res.status(400).send(settingsPage(await loadState(req, { banner: { kind: "error", text: e.message } })));
        }
        throw e;
      }
    }
    await query(`UPDATE merchants SET webhook_url = $1 WHERE id = $2`, [raw || null, p.merchant.id]);
    p.merchant.webhook_url = raw || null;
    res.send(
      settingsPage(
        await loadState(req, {
          banner: { kind: "info", text: raw ? "Webhook URL saved." : "Webhook delivery is off: no URL set." },
        })
      )
    );
  }));

  app.post("/portal/settings/rotate-webhook-secret", session, csrf, recent, changeLimit, route(async (req, res) => {
    const secret = newSecret();
    await query(`UPDATE merchants SET webhook_secret = $1 WHERE id = $2`, [secret, portal(req).merchant.id]);
    res.send(
      settingsPage(
        await loadState(req, {
          reveal: {
            label: "New webhook secret",
            value: secret,
            note: "The old secret stopped working the moment you pressed the button. Update your shop now, or deliveries will fail signature checks.",
          },
        })
      )
    );
  }));

  app.post("/portal/settings/rotate-api-key", session, csrf, recent, changeLimit, route(async (req, res) => {
    const grace = Number((req.body as any)?.grace_minutes ?? 1440);
    const rotated = await rotateApiKey(portal(req).merchant.id, Number.isFinite(grace) ? grace : 1440);
    res.send(
      settingsPage(
        await loadState(req, {
          reveal: {
            label: "New API key",
            value: rotated.apiKey,
            note: rotated.previousExpiresAt
              ? "Paste it into your shop plugin, your .env, and anywhere else that holds it. The old key keeps working until the time shown below, and this page will tell you whether anything is still using it."
              : "The previous key stopped working immediately.",
          },
        })
      )
    );
  }));

  app.post("/portal/settings/revoke-previous-key", session, csrf, recent, changeLimit, route(async (req, res) => {
    const revoked = await revokePreviousKey(portal(req).merchant.id);
    res.send(
      settingsPage(
        await loadState(req, {
          banner: revoked
            ? { kind: "info", text: "The previous key no longer works." }
            : { kind: "info", text: "There was no previous key to revoke." },
        })
      )
    );
  }));

  app.post("/portal/settings/password", session, csrf, recent, changeLimit, route(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const p = portal(req);
    if (body.new_password !== body.new_password2) {
      return res.status(400).send(
        settingsPage(await loadState(req, { banner: { kind: "error", text: "The two passwords do not match." } }))
      );
    }
    const complaint = passwordComplaint(body.new_password, p.username);
    if (complaint) {
      return res.status(400).send(settingsPage(await loadState(req, { banner: { kind: "error", text: complaint } })));
    }
    await setPassword(p.userId, body.new_password);
    const ended = await endOtherSessions(p.userId, p.token);
    res.send(
      settingsPage(
        await loadState(req, {
          banner: {
            kind: "info",
            text: `Password changed${ended ? `, and ${ended} other session${ended === 1 ? "" : "s"} ended` : ""}.`,
          },
        })
      )
    );
  }));

  app.post("/portal/settings/revoke-sessions", session, csrf, recent, route(async (req, res) => {
    const p = portal(req);
    const ended = await endOtherSessions(p.userId, p.token);
    res.send(
      settingsPage(
        await loadState(req, {
          banner: { kind: "info", text: `${ended} other session${ended === 1 ? "" : "s"} ended.` },
        })
      )
    );
  }));
}
