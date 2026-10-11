import type express from "express";

/**
 * Read one cookie from the request.
 *
 * Twelve lines instead of cookie-parser: the gateway sets exactly one cookie,
 * and in a project whose pitch is that it cannot steal your money, every
 * dependency is supply-chain surface that has to earn its place.
 */
export function readCookie(req: express.Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // Values with special characters are sent quoted; strip one layer.
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    try {
      return decodeURIComponent(unquoted);
    } catch {
      // A malformed escape is not worth a 500; treat it as absent.
      return null;
    }
  }
  return null;
}
