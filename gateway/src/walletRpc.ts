// Thin client for monero-wallet-rpc. The RPC server holds one wallet open at a
// time, so every wallet-scoped operation goes through withWallet(), which
// serializes access and opens the right wallet file first.
import { pool } from "./db.js";

const WALLET_RPC_URL = process.env.WALLET_RPC_URL ?? "http://127.0.0.1:18083/json_rpc";
const DAEMON_RPC_URL = process.env.DAEMON_RPC_URL ?? "http://127.0.0.1:18081/json_rpc";

export async function walletRpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  const res = await fetch(WALLET_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
  });
  const json: any = await res.json();
  if (json.error) {
    throw new Error(`wallet-rpc ${method}: ${json.error.message} (${json.error.code})`);
  }
  return json.result as T;
}

export async function daemonRpc<T = any>(method: string, params: unknown = {}): Promise<T> {
  const res = await fetch(DAEMON_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method, params }),
  });
  const json: any = await res.json();
  if (json.error) {
    throw new Error(`daemon-rpc ${method}: ${json.error.message} (${json.error.code})`);
  }
  return json.result as T;
}

const WALLET_PASSWORD = process.env.WALLET_PASSWORD ?? "";

// monero-wallet-rpc holds exactly one wallet open process-wide, but we run two
// clients (API server + worker) against the same daemon. An in-process promise
// chain alone can't stop them from interleaving open/close and clobbering each
// other's unsaved state (e.g. a freshly created subaddress lost before it is
// persisted -> duplicate invoice subaddresses). A Postgres session-level
// advisory lock serializes wallet-rpc access across every process.
const WALLET_LOCK_KEY = 918273645;

async function withWalletLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [WALLET_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [WALLET_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

let chain: Promise<unknown> = Promise.resolve();

export function withWallet<T>(walletName: string, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(() =>
    withWalletLock(async () => {
      await walletRpc("open_wallet", { filename: walletName, password: WALLET_PASSWORD });
      try {
        return await fn();
      } finally {
        await walletRpc("close_wallet").catch(() => {});
      }
    })
  );
  chain = run.catch(() => {});
  return run;
}

/** Cheap reachability probe for /healthz; takes no wallet lock. */
export async function walletRpcVersion(): Promise<number> {
  const { version } = await walletRpc<{ version: number }>("get_version");
  return version;
}

export async function createViewOnlyWallet(
  walletName: string,
  address: string,
  viewKey: string,
  restoreHeight: number
): Promise<void> {
  await withWalletLock(async () => {
    await walletRpc("generate_from_keys", {
      filename: walletName,
      address,
      viewkey: viewKey,
      password: WALLET_PASSWORD,
      restore_height: restoreHeight,
      autosave_current: true,
    });
    await walletRpc("close_wallet").catch(() => {});
  });
}

