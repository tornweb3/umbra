// Point of sale: device enrolment, the 0-conf policy, and charges.
//
// The merchant's API key never reaches the counter phone. A phone behind a
// counter gets lost, borrowed and stolen, and a key on it could not be revoked
// without taking the shop's own integration down at the same time. So a device
// gets its own credential, narrowly scoped and revocable on its own.
import { randomBytes } from "node:crypto";
import type express from "express";
import { sha256Hex } from "./crypto.js";
import { query } from "./db.js";
import { getXmrRate, isSupportedCurrency } from "./rates.js";

export class PosInputError extends Error {}

/** How long an enrolment code is good for. Long enough to walk to the till. */
const ENROL_TTL_MIN = Math.max(1, Number(process.env.ENROL_CODE_TTL_MIN ?? 10));

export interface PosDevice {
  id: string;
  merchant_id: string;
  label: string;
  claimed_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  last_seen_at: string | null;
  default_currency: string | null;
  zeroconf_limit: string;
  zeroconf_currency: string;
  tip_presets: number[];
  charge_expiry_min: number;
  created_at: string;
}

const COLUMNS = `id, merchant_id, label, claimed_at, revoked_at, expires_at, last_seen_at,
  default_currency, zeroconf_limit, zeroconf_currency, tip_presets, charge_expiry_min, created_at`;

export interface DeviceInput {
  label?: unknown;
  default_currency?: unknown;
  zeroconf_limit?: unknown;
  zeroconf_currency?: unknown;
  tip_presets?: unknown;
  charge_expiry_min?: unknown;
}

export function normaliseDevice(input: DeviceInput): Record<string, unknown> {
  const label = String(input.label ?? "").trim();
  if (!label || label.length > 100) throw new PosInputError("Give the device a name, like \"Counter 1\".");

  const currency = input.default_currency ? String(input.default_currency).toUpperCase() : null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new PosInputError("default_currency must be a 3-letter code");

  const limit = input.zeroconf_limit === undefined || input.zeroconf_limit === "" ? 0 : Number(input.zeroconf_limit);
  if (!Number.isFinite(limit) || limit < 0 || limit > 1_000_000) {
    throw new PosInputError("The 0-conf limit must be between 0 and 1000000");
  }
  const limitCurrency = String(input.zeroconf_currency ?? currency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(limitCurrency)) throw new PosInputError("zeroconf_currency must be a 3-letter code");

  let presets: number[] = [];
  if (input.tip_presets !== undefined && input.tip_presets !== null && input.tip_presets !== "") {
    const raw = Array.isArray(input.tip_presets)
      ? input.tip_presets
      : String(input.tip_presets).split(/[,\s]+/).filter(Boolean);
    presets = raw.map((v) => Number(v));
    if (presets.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) {
      throw new PosInputError("Tip presets are percentages between 0 and 100");
    }
    if (presets.length > 4) throw new PosInputError("At most four tip presets");
  }

  const expiry = input.charge_expiry_min === undefined || input.charge_expiry_min === "" ? 15 : Number(input.charge_expiry_min);
  if (!Number.isInteger(expiry) || expiry < 5 || expiry > 1440) {
    throw new PosInputError("The payment window must be between 5 and 1440 minutes");
  }

  return {
    label,
    default_currency: currency,
    zeroconf_limit: limit.toFixed(2),
    zeroconf_currency: limitCurrency,
    tip_presets: JSON.stringify(presets),
    charge_expiry_min: expiry,
  };
}

export interface CreatedDevice {
  device: PosDevice;
  /** Shown once, as a QR. Claimed by the phone, then useless. */
  enrolCode: string;
  enrolExpiresAt: string;
}

export async function createDevice(merchantId: string, input: DeviceInput): Promise<CreatedDevice> {
  const fields = normaliseDevice(input);
  const code = randomBytes(24).toString("base64url");
  try {
    const { rows } = await query(
      `INSERT INTO pos_devices
         (merchant_id, label, default_currency, zeroconf_limit, zeroconf_currency, tip_presets,
          charge_expiry_min, enrol_code_hash, enrol_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9))
       RETURNING ${COLUMNS}, enrol_expires_at`,
      [
        merchantId,
        fields.label,
        fields.default_currency,
        fields.zeroconf_limit,
        fields.zeroconf_currency,
        fields.tip_presets,
        fields.charge_expiry_min,
        sha256Hex(code),
        ENROL_TTL_MIN,
      ]
    );
    return { device: rows[0] as PosDevice, enrolCode: code, enrolExpiresAt: rows[0].enrol_expires_at };
  } catch (e: any) {
    if (String(e?.code) === "23505") throw new PosInputError("A device with that name already exists.");
    throw e;
  }
}

export async function listDevices(merchantId: string): Promise<PosDevice[]> {
  const { rows } = await query(`SELECT ${COLUMNS} FROM pos_devices WHERE merchant_id = $1 ORDER BY created_at`, [
    merchantId,
  ]);
  return rows as PosDevice[];
}

export async function updateDevice(merchantId: string, id: string, input: DeviceInput): Promise<PosDevice | null> {
  const fields = normaliseDevice(input);
  const { rows } = await query(
    `UPDATE pos_devices SET label = $3, default_currency = $4, zeroconf_limit = $5,
            zeroconf_currency = $6, tip_presets = $7, charge_expiry_min = $8
     WHERE id = $1 AND merchant_id = $2 RETURNING ${COLUMNS}`,
    [
      id,
      merchantId,
      fields.label,
      fields.default_currency,
      fields.zeroconf_limit,
      fields.zeroconf_currency,
      fields.tip_presets,
      fields.charge_expiry_min,
    ]
  );
  return (rows[0] as PosDevice) ?? null;
}

/**
 * Revoke a device.
 *
 * This is the answer to a stolen phone, not a PIN: the token sits in that
 * phone's localStorage either way, so a PIN on the page is theatre. Takes
 * effect on the device's very next request, with no worker involved.
 */
export async function revokeDevice(merchantId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE pos_devices SET revoked_at = now(), token_hash = NULL, enrol_code_hash = NULL
     WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL`,
    [id, merchantId]
  );
  return Boolean(rowCount);
}

/** Issue a fresh enrolment code for a device that was never claimed, or was revoked. */
export async function reissueEnrolCode(merchantId: string, id: string): Promise<string | null> {
  const code = randomBytes(24).toString("base64url");
  const { rowCount } = await query(
    `UPDATE pos_devices
     SET enrol_code_hash = $3, enrol_expires_at = now() + make_interval(mins => $4),
         token_hash = NULL, claimed_at = NULL, revoked_at = NULL
     WHERE id = $1 AND merchant_id = $2`,
    [id, merchantId, sha256Hex(code), ENROL_TTL_MIN]
  );
  return rowCount ? code : null;
}

export interface ClaimedDevice {
  token: string;
  device: PosDevice;
}

/**
 * Claim an enrolment code, once.
 *
 * Single-statement and atomic, so two phones scanning the same QR cannot both
 * end up with a credential.
 */
export async function claimDevice(code: string): Promise<ClaimedDevice | null> {
  const token = `xmr_pos_${randomBytes(32).toString("hex")}`;
  const { rows } = await query(
    `UPDATE pos_devices
     SET token_hash = $2, claimed_at = now(), enrol_code_hash = NULL, enrol_expires_at = NULL
     WHERE enrol_code_hash = $1 AND enrol_expires_at > now() AND token_hash IS NULL AND revoked_at IS NULL
     RETURNING ${COLUMNS}`,
    [sha256Hex(code), sha256Hex(token)]
  );
  return rows[0] ? { token, device: rows[0] as PosDevice } : null;
}

export const posDevice = (req: express.Request): PosDevice => (req as any).posDevice;

/**
 * Authenticate a till.
 *
 * A device token is narrow on purpose: it can create and act on its own
 * charges and read its own configuration, and nothing else. It cannot read the
 * merchant's other invoices, change the webhook URL, enrol another device or
 * raise its own 0-conf limit.
 */
export function requirePosDevice(): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) {
        res.status(401).json({ error: "this till is not enrolled" });
        return;
      }
      const { rows } = await query<PosDevice & { wallet_name: string; wallet_ready_at: string | null }>(
        `SELECT d.id, d.merchant_id, d.label, d.claimed_at, d.revoked_at, d.expires_at, d.last_seen_at,
                d.default_currency, d.zeroconf_limit, d.zeroconf_currency, d.tip_presets, d.charge_expiry_min,
                d.created_at, m.wallet_name, m.wallet_ready_at
         FROM pos_devices d JOIN merchants m ON m.id = d.merchant_id
         WHERE d.token_hash = $1 AND d.revoked_at IS NULL
           AND (d.expires_at IS NULL OR d.expires_at > now())`,
        [sha256Hex(token)]
      );
      if (!rows.length) {
        res.status(401).json({ error: "this till has been revoked; enrol it again" });
        return;
      }
      (req as any).posDevice = rows[0];
      // Throttled, and deliberately without an address or a user agent.
      query(
        `UPDATE pos_devices SET last_seen_at = now()
         WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`,
        [rows[0].id]
      ).catch(() => {});
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ---- the 0-conf policy -----------------------------------------------------

/**
 * Decide whether this charge may be accepted at zero confirmations.
 *
 * Evaluated once, at mint time, and frozen onto the invoice. A live policy
 * consulted at display time could flip in the middle of a payment, and an
 * XMR-denominated threshold would silently re-price itself as the market
 * moved: a merchant who set "accept under 0.2 XMR" at $150 has doubled their
 * risk at $300 without touching anything.
 */
export async function acceptZeroconf(device: PosDevice, priceAmount: number, priceCurrency: string | null, xmrRate: number | null): Promise<boolean> {
  const limit = Number(device.zeroconf_limit);
  if (!(limit > 0)) return false;

  // Everything is compared in the limit's own currency.
  let valueInLimitCurrency: number;
  if (priceCurrency && priceCurrency === device.zeroconf_currency) {
    valueInLimitCurrency = priceAmount;
  } else {
    // Convert through XMR: the charge's own locked rate to get XMR, then the
    // limit currency's rate to compare.
    const xmr = priceCurrency && xmrRate ? priceAmount / xmrRate : priceAmount;
    if (!isSupportedCurrency(device.zeroconf_currency)) return false;
    const limitRate = await getXmrRate(device.zeroconf_currency).catch(() => null);
    // Cannot compare, so do not take the risk on the merchant's behalf.
    if (!limitRate) return false;
    valueInLimitCurrency = xmr * limitRate;
  }
  return valueInLimitCurrency <= limit;
}
