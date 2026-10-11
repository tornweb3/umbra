import type express from "express";

/**
 * Headers for the merchant console, on top of the gateway-wide ones.
 *
 * `no-store` and `Vary: Cookie` keep a merchant's pages out of any shared
 * cache that sits in front of the gateway. `frame-ancestors 'none'` and
 * `X-Frame-Options` keep the console out of someone else's frame, which is
 * what makes a clickjacked rotate-credentials button impossible.
 *
 * The CSP allows no inline script and no inline style: everything the pages
 * need is served from /assets, which is also what keeps a merchant-supplied
 * string from ever becoming executable markup.
 */
const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self' data:",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function portalHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Content-Security-Policy", CSP);
    next();
  };
}
