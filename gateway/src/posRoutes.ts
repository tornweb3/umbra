// HTTP surface for the till.
import type express from "express";
import QRCode from "qrcode";
import { query } from "./db.js";
import { merchant, requireAuth, route, UUID_RE } from "./http.js";
import { createInvoice, InvoiceInputError, WalletNotReadyError } from "./invoices.js";
import { INVOICE_SELECT, invoiceJson } from "./invoiceQueries.js";
import { merchantLimit, publicLimit } from "./limits.js";
import { xmrFromAtomic } from "./money.js";
import {
  acceptZeroconf,
  claimDevice,
  createDevice,
  listDevices,
  posDevice,
  PosInputError,
  reissueEnrolCode,
  requirePosDevice,
  revokeDevice,
  updateDevice,
  type PosDevice,
} from "./pos.js";
import { renderEnrol, renderPosMessage, renderReceipt, renderTill } from "./posRender.js";
import { RateUnavailableError } from "./rates.js";
import { rateLimit, serverError } from "./security.js";
import { ensurePoolEnabled, PoolEmptyError } from "./subaddresses.js";
import { enqueueWebhook } from "./webhooks.js";

const enrolLimit = rateLimit({ windowMs: 3_600_000, max: 20, message: "too many enrolment attempts" });
const tillLimit = rateLimit({ windowMs: 60_000, max: 120, key: (req) => posDevice(req).id });
const chargeLimit = rateLimit({ windowMs: 60_000, max: 30, key: (req) => posDevice(req).id });

interface ChargeRow {
  id: string;
  status: string;
  amount_atomic: string;
  received_atomic: string;
  price_amount: string | null;
  price_currency: string | null;
  accept_zeroconf: boolean;
  accepted_at: string | null;
  subaddress: string;
  expires_at: string;
  created_at: string;
}

async function chargeView(baseUrl: string, row: ChargeRow, withQr: boolean) {
  const inv = invoiceJson(row);
  const uri = `monero:${row.subaddress}?tx_amount=${inv.amount_due_xmr}`;
  return {
    id: row.id,
    status: row.status,
    amount_xmr: inv.amount_due_xmr,
    amount_received_xmr: inv.amount_received_xmr,
    display_amount: row.price_amount && row.price_currency ? `${row.price_amount} ${row.price_currency}` : `${inv.amount_due_xmr} XMR`,
    price_amount: row.price_amount,
    price_currency: row.price_currency,
    accept_zeroconf: row.accept_zeroconf,
    accepted_at: row.accepted_at,
    expires_at: row.expires_at,
    // The customer display is the ordinary checkout page: already built,
    // already tested, and the invoice id is its capability.
    customer_url: `${baseUrl}/checkout/${row.id}`,
    receipt_url: `${baseUrl}/pos/receipt/${row.id}`,
    qr: withQr ? await QRCode.toDataURL(uri, { width: 260, margin: 1 }) : undefined,
  };
}

const CHARGE_SELECT = `${INVOICE_SELECT.replace("FROM invoices i", "FROM invoices i")}`;

async function loadCharge(deviceId: string, invoiceId: string): Promise<ChargeRow | null> {
  const { rows } = await query(
    `SELECT i.id, i.status, i.amount_atomic, i.price_amount, i.price_currency, i.accept_zeroconf,
            i.accepted_at, i.subaddress, i.expires_at, i.created_at,
            COALESCE(SUM(p.amount_atomic), 0)::bigint AS received_atomic
     FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id
     WHERE i.id = $1 AND i.pos_device_id = $2
     GROUP BY i.id`,
    [invoiceId, deviceId]
  );
  return (rows[0] as ChargeRow) ?? null;
}

export function mountPosRoutes(app: express.Express, baseUrl: string): void {
  // ---- the till app, which holds no merchant data -------------------------

  app.get("/pos", publicLimit, (_req, res) => res.send(renderTill()));
  app.get("/pos/enrol", publicLimit, (_req, res) => res.send(renderEnrol()));

  app.post("/pos/api/enrol", enrolLimit, route(async (req, res) => {
    const code = String((req.body ?? {}).code ?? "").trim();
    if (!code) return res.status(400).json({ error: "no enrolment code" });
    const claimed = await claimDevice(code);
    if (!claimed) return res.status(403).json({ error: "that code has expired or was already used" });
    res.json({ token: claimed.token, device: { id: claimed.device.id, label: claimed.device.label } });
  }));

  // ---- the device's own API ----------------------------------------------

  const device = requirePosDevice();

  app.get("/pos/api/device", device, tillLimit, (req, res) => {
    const d = posDevice(req) as PosDevice & { wallet_ready_at: string | null };
    res.json({
      label: d.label,
      currency: d.default_currency ?? "XMR",
      zeroconf_limit: Number(d.zeroconf_limit).toFixed(2),
      zeroconf_currency: d.zeroconf_currency,
      tip_presets: d.tip_presets,
      wallet_ready: Boolean(d.wallet_ready_at),
    });
  });

  app.post("/pos/api/charges", device, chargeLimit, route(async (req, res) => {
    const d = posDevice(req) as PosDevice & { wallet_name: string; wallet_ready_at: string | null };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = String(body.amount ?? "").trim();
    if (!/^\d{1,12}(\.\d{1,12})?$/.test(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: "that is not an amount" });
    }
    const currency = d.default_currency;

    try {
      const invoice = await createInvoice(
        { id: d.merchant_id, wallet_name: d.wallet_name, wallet_ready_at: d.wallet_ready_at },
        {
          amount_xmr: currency ? undefined : amount,
          price_amount: currency ? amount : undefined,
          price_currency: currency ?? undefined,
          description: `${d.label}`,
          expires_in_minutes: d.charge_expiry_min,
          metadata: { source: "pos", device: d.label },
        },
        { pool: true, source: "pos" }
      );

      // Decided once, here, and frozen on the row: a live policy could flip
      // mid-payment and an XMR threshold would re-price itself as the market
      // moved.
      const accept = await acceptZeroconf(d, Number(amount), currency, invoice.fiat?.rate ?? null);
      await query(`UPDATE invoices SET pos_device_id = $2, accept_zeroconf = $3 WHERE id = $1`, [
        invoice.id,
        d.id,
        accept,
      ]);

      const row = await loadCharge(d.id, invoice.id);
      res.status(201).json(await chargeView(baseUrl, row!, true));
    } catch (e: any) {
      if (e instanceof InvoiceInputError) return res.status(400).json({ error: e.message });
      if (e instanceof PoolEmptyError || e instanceof WalletNotReadyError || e instanceof RateUnavailableError) {
        res.setHeader("Retry-After", "15");
        return res.status(503).json({ error: e.message });
      }
      throw e;
    }
  }));

  app.get("/pos/api/charges", device, tillLimit, route(async (req, res) => {
    const d = posDevice(req);
    const { rows } = await query(
      `SELECT i.id, i.status, i.amount_atomic, i.price_amount, i.price_currency, i.accept_zeroconf,
              i.accepted_at, i.subaddress, i.expires_at, i.created_at,
              COALESCE(SUM(p.amount_atomic), 0)::bigint AS received_atomic
       FROM invoices i LEFT JOIN payments p ON p.invoice_id = i.id
       WHERE i.pos_device_id = $1
       GROUP BY i.id ORDER BY i.created_at DESC LIMIT 20`,
      [d.id]
    );
    // How a replacement phone finds a sale that was open when a battery died.
    res.json(await Promise.all((rows as ChargeRow[]).map((r) => chargeView(baseUrl, r, false))));
  }));

  app.get("/pos/api/charges/:id", device, tillLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const row = await loadCharge(posDevice(req).id, req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(await chargeView(baseUrl, row, true));
  }));

  app.post("/pos/api/charges/:id/cancel", device, chargeLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const row = await loadCharge(posDevice(req).id, req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });
    // Money already on its way cannot be cancelled: it is going to arrive.
    if (BigInt(row.received_atomic) > 0n) {
      return res.status(409).json({ error: "a payment is already on its way to this charge" });
    }
    await query(`UPDATE invoices SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [req.params.id]);
    const fresh = await loadCharge(posDevice(req).id, req.params.id);
    res.json(await chargeView(baseUrl, fresh!, false));
  }));

  /**
   * The operator says this sale is done.
   *
   * Written to accepted_at, never to status: status is a statement about the
   * chain, and a till does not get to make those. The ledger keeps the two
   * distinguishable forever.
   */
  app.post("/pos/api/charges/:id/accept", device, chargeLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const d = posDevice(req);
    const { rowCount } = await query(
      `UPDATE invoices SET accepted_at = now(), accepted_by_device = $2
       WHERE id = $1 AND pos_device_id = $2 AND accepted_at IS NULL`,
      [req.params.id, d.id]
    );
    if (!rowCount) {
      const existing = await loadCharge(d.id, req.params.id);
      if (!existing) return res.status(404).json({ error: "not found" });
    } else {
      // An operator decision, not a chain event, and labelled as such.
      await enqueueWebhook(req.params.id, "pos_charge_accepted", { accepted_by_device: d.label });
    }
    const fresh = await loadCharge(d.id, req.params.id);
    res.json(await chargeView(baseUrl, fresh!, false));
  }));

  /** A second charge for the shortfall, rather than rewriting the first quote. */
  app.post("/pos/api/charges/:id/remainder", device, chargeLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const d = posDevice(req) as PosDevice & { wallet_name: string; wallet_ready_at: string | null };
    const row = await loadCharge(d.id, req.params.id);
    if (!row) return res.status(404).json({ error: "not found" });

    const short = BigInt(row.amount_atomic) - BigInt(row.received_atomic);
    if (short <= 0n) return res.status(409).json({ error: "nothing is outstanding on this charge" });

    try {
      const invoice = await createInvoice(
        { id: d.merchant_id, wallet_name: d.wallet_name, wallet_ready_at: d.wallet_ready_at },
        {
          amount_xmr: xmrFromAtomic(short),
          description: `${d.label}: remainder`,
          expires_in_minutes: d.charge_expiry_min,
          metadata: { source: "pos", device: d.label, remainder_of: row.id },
        },
        { pool: true, source: "pos" }
      );
      await query(
        `UPDATE invoices SET pos_device_id = $2, accept_zeroconf = $3, remainder_of = $4 WHERE id = $1`,
        [invoice.id, d.id, row.accept_zeroconf, row.id]
      );
      const fresh = await loadCharge(d.id, invoice.id);
      res.status(201).json(await chargeView(baseUrl, fresh!, true));
    } catch (e: any) {
      if (e instanceof PoolEmptyError || e instanceof WalletNotReadyError) {
        res.setHeader("Retry-After", "15");
        return res.status(503).json({ error: e.message });
      }
      throw e;
    }
  }));

  // ---- the receipt, whose capability is the invoice id --------------------

  app.get("/pos/receipt/:id", publicLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).send(renderPosMessage("Not found", "No such payment."));
    const { rows } = await query<any>(
      `SELECT i.id, i.created_at, i.status, i.amount_atomic, i.tip_atomic, i.price_amount, i.price_currency,
              i.accepted_at, d.label AS device_label, m.name AS merchant_name,
              COALESCE(SUM(p.amount_atomic), 0)::bigint AS received_atomic,
              COALESCE(array_agg(p.txid) FILTER (WHERE p.txid IS NOT NULL), '{}') AS txids
       FROM invoices i
       JOIN merchants m ON m.id = i.merchant_id
       LEFT JOIN pos_devices d ON d.id = i.pos_device_id
       LEFT JOIN payments p ON p.invoice_id = i.id
       WHERE i.id = $1
       GROUP BY i.id, d.label, m.name`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).send(renderPosMessage("Not found", "No such payment."));
    const checkoutUrl = `${baseUrl}/checkout/${req.params.id}`;
    const qr = await QRCode.toDataURL(checkoutUrl, { width: 160, margin: 1 });
    res.send(renderReceipt(rows[0], checkoutUrl, qr));
  }));

  // ---- the merchant's device management ----------------------------------

  app.get("/api/pos/devices", requireAuth, merchantLimit, route(async (req, res) => {
    res.json(await listDevices(merchant(req).id));
  }));

  app.post("/api/pos/devices", requireAuth, merchantLimit, route(async (req, res) => {
    try {
      const created = await createDevice(merchant(req).id, req.body ?? {});
      await ensurePoolEnabled(merchant(req).id);
      res.status(201).json({
        device: created.device,
        enrol_code: created.enrolCode,
        enrol_expires_at: created.enrolExpiresAt,
        enrol_url: `${baseUrl}/pos/enrol#${created.enrolCode}`,
        note: "Shown once. Open the enrol_url on the till, or scan it from the console.",
      });
    } catch (e: any) {
      if (e instanceof PosInputError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }));

  app.patch("/api/pos/devices/:id", requireAuth, merchantLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    try {
      const updated = await updateDevice(merchant(req).id, req.params.id, req.body ?? {});
      if (!updated) return res.status(404).json({ error: "not found" });
      res.json(updated);
    } catch (e: any) {
      if (e instanceof PosInputError) return res.status(400).json({ error: e.message });
      throw e;
    }
  }));

  app.post("/api/pos/devices/:id/revoke", requireAuth, merchantLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, revoked: await revokeDevice(merchant(req).id, req.params.id) });
  }));

  app.post("/api/pos/devices/:id/enrol-code", requireAuth, merchantLimit, route(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "not found" });
    const code = await reissueEnrolCode(merchant(req).id, req.params.id);
    if (!code) return res.status(404).json({ error: "not found" });
    res.json({ enrol_code: code, enrol_url: `${baseUrl}/pos/enrol#${code}`, note: "Shown once." });
  }));
}
