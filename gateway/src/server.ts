import "dotenv/config";
import { pool } from "./db.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

// Loopback by default: in production the gateway belongs behind a reverse
// proxy that terminates TLS. Set BIND_ADDRESS=0.0.0.0 only when something else
// (a container network, a firewall) controls who can reach the port.
const BIND_ADDRESS = process.env.BIND_ADDRESS ?? "127.0.0.1";

const app = createApp({ baseUrl: BASE_URL, network: process.env.MONERO_NETWORK ?? "mainnet" });

const server = app.listen(PORT, BIND_ADDRESS, () => {
  console.log(`gateway server listening on http://${BIND_ADDRESS}:${PORT}`);
});

// Containers and systemd send SIGTERM: stop accepting connections, let the
// in-flight requests finish, then let the pool go.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    // A request wedged on the wallet lock shouldn't hold the process forever.
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
