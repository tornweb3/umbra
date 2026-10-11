// The console's point-of-sale device management.
import type express from "express";
import QRCode from "qrcode";
import { route, UUID_RE } from "../http.js";
import { merchantActionLimit } from "../limits.js";
import {
  createDevice,
  listDevices,
  PosInputError,
  reissueEnrolCode,
  revokeDevice,
  updateDevice,
  type PosDevice,
} from "../pos.js";
import { SUPPORTED_CURRENCIES } from "../rates.js";
import { ensurePoolEnabled } from "../subaddresses.js";
import { timestamp, when } from "../ui/components.js";
import { html, type SafeHtml } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { portalNav } from "./nav.js";
import { portal, requireCsrf, requireSession } from "./session.js";

export interface PosRoutesOptions {
  baseUrl: string;
}

function state(d: PosDevice): string {
  if (d.revoked_at) return "revoked";
  if (d.claimed_at) return "in use";
  return "waiting to be enrolled";
}

/** Shown once, right after a code is issued. */
function enrolCard(url: string, qr: string, label: string): SafeHtml {
  return html`<div class="card left">
<h2>Enrol ${label}</h2>
<p class="hint">Open this on the till, or scan it with the phone you are putting behind the
counter. It works once and lasts ten minutes.</p>
<img src="${qr}" alt="Enrolment code" width="220" height="220">
<p class="addr mono wrap">${url}</p>
<p class="hint">The code is in the part of the URL after the # , which browsers never send to a
server, so it does not appear in any access log on the way. The till swaps it for its own
credential, which you can revoke on its own without touching your API key.</p>
</div>`;
}

function listView(
  opts: { baseUrl: string; csrf: string; devices: PosDevice[]; banner?: string; error?: string; enrol?: SafeHtml }
): string {
  const body = html`<h1>Point of sale</h1>
<p class="muted">A till that runs in a browser. Each device gets its own credential, never your
API key, and a stolen phone can be revoked on its own. Nothing on a till can move funds: this
gateway holds a view key.</p>
${when(opts.banner, () => html`<div class="banner info">${opts.banner}</div>`)}
${when(opts.error, () => html`<div class="banner error">${opts.error}</div>`)}
${opts.enrol ?? ""}

${when(
  opts.devices.length > 0,
  () => html`<table>
<thead><tr><th>Device</th><th>State</th><th>0-conf limit</th><th>Last seen</th><th></th></tr></thead>
<tbody>${opts.devices.map(
    (d) => html`<tr>
<td>${d.label}</td>
<td>${state(d)}</td>
<td>${Number(d.zeroconf_limit) > 0 ? html`${d.zeroconf_limit} ${d.zeroconf_currency}` : html`<span class="muted">confirmations always</span>`}</td>
<td>${timestamp(d.last_seen_at)}</td>
<td>
<form method="post" action="/portal/pos/${d.id}/code"><input type="hidden" name="_csrf" value="${opts.csrf}"><button class="secondary" type="submit">New code</button></form>
${when(
      !d.revoked_at,
      () => html`<form method="post" action="/portal/pos/${d.id}/revoke"><input type="hidden" name="_csrf" value="${opts.csrf}"><button class="secondary" type="submit">Revoke</button></form>`
    )}
</td>
</tr>`
  )}</tbody></table>`
)}

<form method="post" action="/portal/pos" class="card left">
<input type="hidden" name="_csrf" value="${opts.csrf}">
<h2>Add a device</h2>
<label for="label">Name</label>
<input id="label" name="label" required maxlength="100" placeholder="Counter 1">
<label for="default_currency">Prices entered in</label>
<select id="default_currency" name="default_currency">
<option value="">XMR</option>
${SUPPORTED_CURRENCIES.map((c) => html`<option value="${c}">${c}</option>`)}
</select>
<label for="zeroconf_limit">Accept unconfirmed payments up to</label>
<input id="zeroconf_limit" name="zeroconf_limit" inputmode="decimal" value="0">
<select name="zeroconf_currency">
${SUPPORTED_CURRENCIES.map((c) => html`<option value="${c}" ${c === "USD" ? "selected" : ""}>${c}</option>`)}
</select>
<p class="hint">A payment with no confirmations can still be reversed, so this is your own risk
budget, not a technical setting. Zero, the default, waits for confirmations on every sale.</p>
<label for="charge_expiry_min">Payment window (minutes)</label>
<input id="charge_expiry_min" name="charge_expiry_min" type="number" min="5" max="1440" value="15">
<button type="submit">Create device</button>
</form>
<p class="muted">The till itself is at <a href="/pos">/pos</a> on this gateway.</p>`;
  return layout({ title: "Point of sale", body, chrome: "portal", nav: portalNav("pos") });
}

export function mountPortalPosRoutes(app: express.Express, opts: PosRoutesOptions): void {
  const session = requireSession();
  const csrf = requireCsrf(opts.baseUrl);

  const render = async (req: express.Request, extra: Partial<Parameters<typeof listView>[0]> = {}) =>
    listView({
      baseUrl: opts.baseUrl,
      csrf: portal(req).csrf,
      devices: await listDevices(portal(req).merchant.id),
      ...extra,
    });

  app.get("/portal/pos", session, route(async (req, res) => {
    res.send(await render(req));
  }));

  app.post("/portal/pos", session, csrf, merchantActionLimit, route(async (req, res) => {
    try {
      const created = await createDevice(portal(req).merchant.id, (req.body ?? {}) as Record<string, string>);
      await ensurePoolEnabled(portal(req).merchant.id);
      const url = `${opts.baseUrl}/pos/enrol#${created.enrolCode}`;
      // Rendered here, once, rather than redirected to: a code in a query
      // string lands in proxy logs and browser history.
      res.send(
        await render(req, {
          banner: `${created.device.label} is ready to enrol.`,
          enrol: enrolCard(url, await QRCode.toDataURL(url, { width: 220, margin: 1 }), created.device.label),
        })
      );
    } catch (e: any) {
      if (e instanceof PosInputError) return res.status(400).send(await render(req, { error: e.message }));
      throw e;
    }
  }));

  app.post("/portal/pos/:id/code", session, csrf, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send(await render(req, { error: "No such device." }));
    const code = await reissueEnrolCode(portal(req).merchant.id, req.params.id);
    if (!code) return res.status(404).send(await render(req, { error: "No such device." }));
    const devices = await listDevices(portal(req).merchant.id);
    const label = devices.find((d) => d.id === req.params.id)?.label ?? "this device";
    const url = `${opts.baseUrl}/pos/enrol#${code}`;
    res.send(
      await render(req, {
        banner: "A new code was issued. The device's previous credential no longer works.",
        enrol: enrolCard(url, await QRCode.toDataURL(url, { width: 220, margin: 1 }), label),
      })
    );
  }));

  app.post("/portal/pos/:id/revoke", session, csrf, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send(await render(req, { error: "No such device." }));
    const revoked = await revokeDevice(portal(req).merchant.id, req.params.id);
    res.send(
      await render(req, {
        banner: revoked
          ? "Revoked. That till stops working on its very next request."
          : "That device was already revoked.",
      })
    );
  }));

  app.post("/portal/pos/:id", session, csrf, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send(await render(req, { error: "No such device." }));
    try {
      const updated = await updateDevice(portal(req).merchant.id, req.params.id, (req.body ?? {}) as Record<string, string>);
      if (!updated) return res.status(404).send(await render(req, { error: "No such device." }));
      res.send(await render(req, { banner: `${updated.label} updated.` }));
    } catch (e: any) {
      if (e instanceof PosInputError) return res.status(400).send(await render(req, { error: e.message }));
      throw e;
    }
  }));
}
