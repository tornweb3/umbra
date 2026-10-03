// Test webhook receiver: verifies the HMAC-SHA256 signature of incoming
// gateway webhooks. Usage: node webhook-receiver.mjs <webhook_secret> [port]
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const secret = process.argv[2];
const port = Number(process.argv[3] ?? 4000);
if (!secret) {
  console.error("usage: node webhook-receiver.mjs <webhook_secret> [port]");
  process.exit(1);
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sig = req.headers["x-webhook-signature"] ?? "";
      const expected = createHmac("sha256", secret).update(body).digest("hex");
      const valid =
        sig.length === expected.length &&
        timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      console.log(`[${new Date().toISOString()}] ${req.headers["x-webhook-event"]}`);
      console.log(`  signature: ${sig}`);
      console.log(`  valid:     ${valid ? "YES" : "NO"}`);
      console.log(`  body:      ${body}`);
      res.writeHead(valid ? 200 : 400).end(valid ? "ok" : "bad signature");
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`webhook receiver on http://127.0.0.1:${port}/hook (any path)`));
