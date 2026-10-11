// The status page: what a self-hoster needs when something looks wrong, and
// the page the one-click app stores want a headless app to open to.
//
// It answers four questions in order of how often they are the problem: is the
// worker running, is the node synced, is anything stuck in a queue, and what
// version is this.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import { query } from "../db.js";
import { route } from "../http.js";
import { rateLimit } from "../security.js";
import { daemonRpc, walletRpcVersion } from "../walletRpc.js";
import { timestamp, when } from "../ui/components.js";
import { html, type SafeHtml } from "../ui/html.js";
import { layout } from "../ui/layout.js";
import { portalNav } from "./nav.js";
import { requireSession } from "./session.js";

export interface StatusOptions {
  baseUrl: string;
  network: string;
}

const VERSION = (() => {
  // Works from src under tsx and from dist under node: both are one level in.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "..", "..", "package.json"), path.join(here, "..", "..", "..", "package.json")]) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")).version as string;
    } catch {
      /* try the next one */
    }
  }
  return "unknown";
})();

const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15000);
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 10);

interface Probe {
  label: string;
  ok: boolean;
  detail: string;
}

interface Snapshot {
  probes: Probe[];
  worker: { last_pass_at: string | null; pass_ms: number | null; last_error: string | null };
  queues: { pending: number; detected: number; undelivered: number; provisioning: number; failed_wallets: number };
  migrations: Array<{ filename: string; applied_at: string }>;
  at: number;
}

let cached: Snapshot | null = null;
const CACHE_MS = 10_000;

async function probe(label: string, fn: () => Promise<string>): Promise<Probe> {
  try {
    return { label, ok: true, detail: await fn() };
  } catch (e: any) {
    return { label, ok: false, detail: String(e?.message ?? e).slice(0, 200) };
  }
}

async function snapshot(): Promise<Snapshot> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;

  const probes = [
    await probe("Database", async () => {
      await query("SELECT 1");
      return "reachable";
    }),
    await probe("monero-wallet-rpc", async () => `version ${await walletRpcVersion()}`),
    await probe("monerod", async () => {
      const info = await daemonRpc<{ height: number; synchronized: boolean; target_height: number }>("get_info");
      if (!info.synchronized) {
        const target = info.target_height || info.height;
        return `syncing, height ${info.height} of ${target}`;
      }
      return `synced, height ${info.height}`;
    }),
  ];
  // A syncing node is not an error, but it is not ready either: payments to
  // blocks it has not seen cannot be detected yet.
  const daemon = probes[2];
  if (daemon.ok && daemon.detail.startsWith("syncing")) daemon.ok = false;

  const empty = { last_pass_at: null, pass_ms: null, last_error: null };
  let worker = empty;
  let queues = { pending: 0, detected: 0, undelivered: 0, provisioning: 0, failed_wallets: 0 };
  let migrations: Snapshot["migrations"] = [];
  if (probes[0].ok) {
    const hb = await query<typeof empty>(`SELECT last_pass_at, pass_ms, last_error FROM worker_heartbeat WHERE id`);
    worker = hb.rows[0] ?? empty;
    const q = await query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM invoices WHERE status = 'pending')::text AS pending,
         (SELECT count(*) FROM invoices WHERE status = 'detected')::text AS detected,
         (SELECT count(*) FROM webhook_deliveries WHERE delivered_at IS NULL AND attempts > 0)::text AS undelivered,
         (SELECT count(*) FROM merchants WHERE wallet_ready_at IS NULL)::text AS provisioning,
         (SELECT count(*) FROM merchants WHERE wallet_ready_at IS NULL AND wallet_error IS NOT NULL)::text AS failed_wallets`
    );
    const r = q.rows[0] ?? {};
    queues = {
      pending: Number(r.pending ?? 0),
      detected: Number(r.detected ?? 0),
      undelivered: Number(r.undelivered ?? 0),
      provisioning: Number(r.provisioning ?? 0),
      failed_wallets: Number(r.failed_wallets ?? 0),
    };
    const m = await query<{ filename: string; applied_at: string }>(
      `SELECT filename, applied_at FROM schema_migrations ORDER BY filename`
    );
    migrations = m.rows;
  }

  cached = { probes, worker, queues, migrations, at: Date.now() };
  return cached;
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** A worker that has not run in several poll intervals is a stopped worker. */
export function workerLooksStopped(lastPassAt: string | null, pollMs = POLL_MS): boolean {
  if (!lastPassAt) return true;
  return Date.now() - new Date(lastPassAt).getTime() > Math.max(pollMs * 4, 60_000);
}

function statusPage(s: Snapshot, opts: StatusOptions): string {
  const stopped = workerLooksStopped(s.worker.last_pass_at);
  const row = (label: string, value: SafeHtml | string) => html`<tr><th>${label}</th><td>${value}</td></tr>`;
  const body = html`<h1>Status</h1>

${when(
  stopped,
  () => html`<div class="banner error">The worker has not completed a pass ${s.worker.last_pass_at ? html`since ${ago(s.worker.last_pass_at)}` : html`at all`}.
Nothing is being scanned, no webhook is being delivered and no wallet is being prepared while that
is true. Start it with <span class="mono">npm run start:worker</span>, or
<span class="mono">docker compose up -d worker</span>.</div>`
)}
${when(
  s.worker.last_error,
  () => html`<div class="banner warn">The worker's last pass reported: ${s.worker.last_error}</div>`
)}
${when(
  s.queues.failed_wallets > 0,
  () => html`<div class="banner warn">${s.queues.failed_wallets} account${s.queues.failed_wallets === 1 ? "" : "s"}
could not have a wallet prepared. The worker retries every pass; check that monero-wallet-rpc is
reachable.</div>`
)}

<div class="card left">
<h2>Services</h2>
<table>
${s.probes.map(
  (p) => html`<tr><th>${p.label}</th><td><span class="dot ${p.ok ? "up" : "down"}"></span>${p.detail}</td></tr>`
)}
${row(
  "Worker",
  html`<span class="dot ${stopped ? "down" : "up"}"></span>last pass ${ago(s.worker.last_pass_at)}${when(
    s.worker.pass_ms !== null,
    () => html`, took ${s.worker.pass_ms}ms`
  )}`
)}
</table>
<p class="hint">The deep checks are cached for ten seconds, so reloading this page does not hammer
your node.</p>
</div>

<div class="card left">
<h2>Queues</h2>
<table>
${row("Invoices awaiting payment", String(s.queues.pending))}
${row("Seen, awaiting confirmations", String(s.queues.detected))}
${row("Webhooks retrying", String(s.queues.undelivered))}
${row("Wallets still being prepared", String(s.queues.provisioning))}
</table>
</div>

<div class="card left">
<h2>This gateway</h2>
<table>
${row("Version", VERSION)}
${row("Network", opts.network)}
${row("Public base URL", opts.baseUrl)}
${row("Confirmations required", String(CONFIRMATIONS))}
${row("Worker poll interval", `${POLL_MS}ms`)}
${row("Migrations applied", String(s.migrations.length))}
</table>
<details><summary class="muted">Migration history</summary>
<table>
${s.migrations.map((m) => html`<tr><th>${m.filename}</th><td>${timestamp(m.applied_at)}</td></tr>`)}
</table>
</details>
</div>`;
  return layout({ title: "Status", body, chrome: "portal", nav: portalNav("status") });
}

export function mountStatusRoutes(app: express.Express, opts: StatusOptions): void {
  const session = requireSession();
  // The page is cheap because of the cache, but the probes behind it are not.
  const statusLimit = rateLimit({ windowMs: 60_000, max: 30 });

  app.get("/portal/status", session, statusLimit, route(async (_req, res) => {
    res.send(statusPage(await snapshot(), opts));
  }));
}

/** Testing seam: the cache is process-wide and deliberately not per request. */
export function clearStatusCache(): void {
  cached = null;
}
