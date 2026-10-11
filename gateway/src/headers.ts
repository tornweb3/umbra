import type express from "express";

/**
 * Headers every gateway response carries.
 *
 * `no-referrer` is the load-bearing one: an invoice UUID is the capability for
 * its own checkout page, and buyers click `return_url` out to the merchant's
 * site, so the default referrer policy would hand that capability to the
 * merchant's server logs and to anything embedded on their page.
 */
export function securityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  };
}
