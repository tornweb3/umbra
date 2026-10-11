// A stand-in for monero-wallet-rpc and monerod, so the whole payment path can
// be exercised without a node, a wallet or any coins.
//
//   node tools/wallet-mock.mjs 4200
//   WALLET_RPC_URL=http://127.0.0.1:4200/json_rpc \
//   DAEMON_RPC_URL=http://127.0.0.1:4200/daemon/json_rpc npm run server
//
// Then pay an invoice:
//
//   curl -X POST localhost:4200/_mock/pay \
//     -d '{"subaddr_index":1,"amount_xmr":"0.5","confirmations":0}'
//   curl -X POST localhost:4200/_mock/confirm -d '{"txid":"...","confirmations":10}'
//
// It is deliberately strict about one thing: the real wallet-rpc holds exactly
// one wallet open at a time, and calls that need a wallet fail when none is
// open. Anything that forgets withWallet() therefore fails here too, loudly,
// instead of working in testing and breaking against the real thing.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const port = Number(process.argv[2] ?? 4200);
const PICO = 1_000_000_000_000n;

/** @type {Map<string, {address: string, viewkey: string, restoreHeight: number, subaddresses: string[]}>} */
const wallets = new Map();
let open = null;
/** @type {Array<{txid: string, wallet: string, amount: bigint, confirmations: number, minor: number}>} */
let transfers = [];
let height = 3_200_000;

const subaddressFor = (name, index) =>
  // Deterministic and obviously fake, so nobody mistakes it for a real one.
  `8MOCK${index.toString().padStart(4, "0")}${name.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`.padEnd(95, "x");

function walletResult(method, params) {
  switch (method) {
    case "get_version":
      return { version: 65558 };

    case "generate_from_keys": {
      const { filename, address, viewkey, restore_height = 0 } = params ?? {};
      if (!filename) throw rpcError(-1, "filename required");
      if (wallets.has(filename)) throw rpcError(-21, "Wallet already exists.");
      wallets.set(filename, {
        address,
        viewkey,
        restoreHeight: restore_height,
        subaddresses: [address],
      });
      open = filename;
      return { address, info: "Wallet has been generated successfully." };
    }

    case "open_wallet": {
      const { filename } = params ?? {};
      if (!wallets.has(filename)) throw rpcError(-1, `Failed to open wallet: ${filename}`);
      open = filename;
      return {};
    }

    case "close_wallet":
      open = null;
      return {};

    case "refresh":
      requireOpen();
      return { blocks_fetched: 0, received_money: false };

    case "store":
      requireOpen();
      return {};

    case "get_address": {
      const w = requireOpen();
      return {
        address: w.subaddresses[0],
        addresses: w.subaddresses.map((address, address_index) => ({
          address,
          address_index,
          label: address_index === 0 ? "Primary account" : "invoice",
          used: false,
        })),
      };
    }

    case "create_address": {
      const w = requireOpen();
      const address_index = w.subaddresses.length;
      const address = subaddressFor(open, address_index);
      w.subaddresses.push(address);
      return { address, address_index };
    }

    case "get_transfers": {
      const w = requireOpen();
      const mine = transfers.filter((t) => t.wallet === open);
      const shape = (t) => ({
        txid: t.txid,
        // The real thing sends these as JSON numbers, which is where the
        // ~9000 XMR precision limit in the worker comes from. Keep that.
        amount: Number(t.amount),
        confirmations: t.confirmations,
        subaddr_index: { major: 0, minor: t.minor },
        height: t.confirmations > 0 ? height - t.confirmations : 0,
      });
      const out = {};
      if (params?.in) out.in = mine.filter((t) => t.confirmations > 0).map(shape);
      if (params?.pool) out.pool = mine.filter((t) => t.confirmations === 0).map(shape);
      void w;
      return out;
    }

    default:
      throw rpcError(-32601, `mock does not implement ${method}`);
  }
}

function daemonResult(method) {
  switch (method) {
    case "get_info":
      return { height, target_height: 0, synchronized: true, status: "OK", mainnet: false, stagenet: true };
    default:
      throw rpcError(-32601, `mock does not implement daemon ${method}`);
  }
}

function requireOpen() {
  if (!open) throw rpcError(-13, "No wallet file");
  return wallets.get(open);
}

function rpcError(code, message) {
  const e = new Error(message);
  e.rpc = { code, message };
  return e;
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://mock");
  const body = req.method === "POST" ? await readBody(req) : {};

  if (url.pathname === "/json_rpc" || url.pathname === "/daemon/json_rpc") {
    const { id = 0, method, params } = body;
    try {
      const result = url.pathname === "/json_rpc" ? walletResult(method, params) : daemonResult(method);
      return json(res, 200, { id, jsonrpc: "2.0", result });
    } catch (e) {
      return json(res, 200, { id, jsonrpc: "2.0", error: e.rpc ?? { code: -1, message: String(e.message) } });
    }
  }

  // ---- controls -----------------------------------------------------------

  if (url.pathname === "/_mock/pay" && req.method === "POST") {
    const wallet = body.wallet ?? [...wallets.keys()].at(-1);
    if (!wallet) return json(res, 400, { error: "no wallet has been created yet" });
    const minor = Number(body.subaddr_index);
    if (!Number.isInteger(minor)) return json(res, 400, { error: "subaddr_index required" });
    const amount =
      body.amount_atomic !== undefined
        ? BigInt(body.amount_atomic)
        : BigInt(Math.round(Number(body.amount_xmr) * 1e12));
    const txid = body.txid ?? randomBytes(32).toString("hex");
    transfers.push({ txid, wallet, amount, confirmations: Number(body.confirmations ?? 0), minor });
    return json(res, 200, { txid, wallet, minor, amount_atomic: amount.toString() });
  }

  if (url.pathname === "/_mock/confirm" && req.method === "POST") {
    const n = Number(body.confirmations ?? 10);
    const hit = transfers.filter((t) => !body.txid || t.txid === body.txid);
    for (const t of hit) t.confirmations = n;
    return json(res, 200, { updated: hit.length, confirmations: n });
  }

  // A 0-conf transfer that vanishes: the double-spend case the worker reverts.
  if (url.pathname === "/_mock/drop" && req.method === "POST") {
    const before = transfers.length;
    transfers = transfers.filter((t) => (body.txid ? t.txid !== body.txid : t.confirmations > 0));
    return json(res, 200, { dropped: before - transfers.length });
  }

  if (url.pathname === "/_mock/height" && req.method === "POST") {
    height = Number(body.height ?? height);
    return json(res, 200, { height });
  }

  if (url.pathname === "/_mock/state") {
    return json(res, 200, {
      height,
      open,
      wallets: [...wallets.entries()].map(([name, w]) => ({
        name,
        restore_height: w.restoreHeight,
        subaddresses: w.subaddresses.length,
      })),
      transfers: transfers.map((t) => ({
        txid: t.txid,
        wallet: t.wallet,
        minor: t.minor,
        xmr: (Number(t.amount) / Number(PICO)).toFixed(12),
        confirmations: t.confirmations,
      })),
    });
  }

  if (url.pathname === "/_mock/reset" && req.method === "POST") {
    wallets.clear();
    transfers = [];
    open = null;
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`wallet mock on http://127.0.0.1:${port}`);
  console.log(`  wallet: http://127.0.0.1:${port}/json_rpc`);
  console.log(`  daemon: http://127.0.0.1:${port}/daemon/json_rpc`);
  console.log(`  pay:    curl -X POST localhost:${port}/_mock/pay -d '{"subaddr_index":1,"amount_xmr":"0.5"}'`);
});
