// Request helpers shared by the API server and the Shopify routes.
import type express from "express";
import { query } from "./db.js";
import { sha256Hex } from "./crypto.js";

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Merchant {
  id: string;
  name: string;
  address: string;
  wallet_name: string;
  webhook_url: string;
  webhook_secret: string;
  created_at: string;
}

// Authenticated routes read the merchant from the Bearer API key.
export async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) {
    res.status(401).json({ error: "missing Bearer API key" });
    return;
  }
  const { rows } = await query<Merchant>(
    `SELECT id, name, address, wallet_name, webhook_url, webhook_secret, created_at
     FROM merchants WHERE api_key_hash = $1`,
    [sha256Hex(key)]
  );
  if (rows.length === 0) {
    res.status(401).json({ error: "invalid API key" });
    return;
  }
  (req as any).merchant = rows[0];
  next();
}

/** Route params reach SQL as uuids; a malformed one is a 404, not a 500. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const merchant = (req: express.Request): Merchant => (req as any).merchant;
