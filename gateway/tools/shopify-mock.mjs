// Local stand-in for a Shopify store's Admin API, for exercising the Shopify
// bridge without a real store. Start the gateway (server + worker) with
// SHOPIFY_TEST_API_BASE=http://127.0.0.1:<port>, connect with the credentials
// below and any <name>.myshopify.com domain, then drive orders:
//
//   node tools/shopify-mock.mjs [port] [client_id] [client_secret]
//   curl -X POST localhost:4100/_mock/orders -d '{"amount":"25.00","currency":"USD"}'
//   curl -X POST localhost:4100/_mock/orders/<id>/cancel
//   curl localhost:4100/_mock/state
//
// It implements only what the bridge calls: the client-credentials token
// endpoint, and the GraphQL shop / order / orders / webhookSubscriptionCreate /
// orderMarkAsPaid operations. New and cancelled orders fire HMAC-signed
// webhooks at every registered subscription, as Shopify would.
import http from "node:http";
import { createHmac } from "node:crypto";

const port = Number(process.argv[2] ?? 4100);
const CLIENT_ID = process.argv[3] ?? "mock_client_id";
const CLIENT_SECRET = process.argv[4] ?? "mock_client_secret";
const TOKEN = "mock_access_token";

// Seed ids from the clock so a restarted mock never reuses an order id or
// number the gateway already has on record.
const state = {
  webhooks: [],
  orders: new Map(),
  nextId: Date.now() * 1000,
  nextNumber: 1001 + (Math.floor(Date.now() / 1000) % 90_000),
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
}

function gqlOrder(o) {
  return {
    id: o.gid,
    name: o.name,
    number: o.number,
    paymentGatewayNames: [o.gateway],
    displayFinancialStatus: o.financial,
    cancelledAt: o.cancelledAt,
    statusPageUrl: `https://mock-shop.example/orders/${o.id}/status`,
    totalOutstandingSet: {
      presentmentMoney: { amount: o.financial === "PAID" ? "0.00" : o.amount, currencyCode: o.currency },
    },
  };
}

async function fireWebhook(topic, o) {
  const body = JSON.stringify({
    id: o.id, admin_graphql_api_id: o.gid, name: o.name, order_number: o.number, payment_gateway_names: [o.gateway],
  });
  const hmac = createHmac("sha256", CLIENT_SECRET).update(body).digest("base64");
  for (const w of state.webhooks.filter((x) => x.topic === topic)) {
    try {
      const r = await fetch(w.uri, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Hmac-SHA256": hmac, "X-Shopify-Topic": topic.toLowerCase() },
        body,
      });
      console.log(`webhook ${topic} -> ${w.uri}: HTTP ${r.status}`);
    } catch (e) {
      console.log(`webhook ${topic} -> ${w.uri}: ${e.message}`);
    }
  }
}

function handleGraphql(query, variables) {
  if (/webhookSubscriptionCreate/.test(query)) {
    const { topic, webhookSubscription } = variables;
    if (state.webhooks.some((w) => w.topic === topic && w.uri === webhookSubscription.uri))
      return { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ["webhookSubscription", "uri"], message: "Address for this topic has already been taken" }] } };
    state.webhooks.push({ topic, uri: webhookSubscription.uri });
    return { webhookSubscriptionCreate: { webhookSubscription: { id: `gid://shopify/WebhookSubscription/${state.webhooks.length}` }, userErrors: [] } };
  }
  if (/orderMarkAsPaid/.test(query)) {
    const o = [...state.orders.values()].find((x) => x.gid === variables.input.id);
    if (!o) return { orderMarkAsPaid: { order: null, userErrors: [{ field: ["id"], message: "Order does not exist" }] } };
    if (o.financial === "PAID") return { orderMarkAsPaid: { order: null, userErrors: [{ field: ["id"], message: "Order cannot be marked as paid" }] } };
    o.financial = "PAID";
    console.log(`order ${o.name} marked PAID`);
    return { orderMarkAsPaid: { order: { id: o.gid, displayFinancialStatus: "PAID" }, userErrors: [] } };
  }
  if (/\borders\s*\(/.test(query)) {
    const nodes = [...state.orders.values()].filter((o) => o.financial === "PENDING").reverse().map(gqlOrder);
    return { orders: { nodes } };
  }
  if (/\border\s*\(/.test(query)) {
    const o = [...state.orders.values()].find((x) => x.gid === variables.id);
    return { order: o ? gqlOrder(o) : null };
  }
  if (/\bshop\s*\{/.test(query)) return { shop: { name: "Mock Shop" } };
  return null;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const raw = await readBody(req);

    if (req.method === "POST" && url.pathname === "/admin/oauth/access_token") {
      const f = new URLSearchParams(raw);
      if (f.get("grant_type") !== "client_credentials" || f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET)
        return send(res, 400, { error: "invalid_client", error_description: "Client credentials are invalid" });
      return send(res, 200, { access_token: TOKEN, scope: "read_orders,write_orders", expires_in: 86399 });
    }

    if (req.method === "POST" && /^\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname)) {
      if (req.headers["x-shopify-access-token"] !== TOKEN) return send(res, 401, { errors: "[API] Invalid API key or access token" });
      const { query, variables } = JSON.parse(raw || "{}");
      const data = handleGraphql(query ?? "", variables ?? {});
      return data ? send(res, 200, { data }) : send(res, 200, { errors: [{ message: "mock: unsupported operation" }] });
    }

    // ---- test controls ----
    if (req.method === "POST" && url.pathname === "/_mock/orders") {
      const b = JSON.parse(raw || "{}");
      const id = state.nextId++;
      const number = state.nextNumber++;
      const o = {
        id, gid: `gid://shopify/Order/${id}`, number, name: `#${number}`,
        amount: b.amount ?? "25.00", currency: b.currency ?? "USD",
        gateway: b.gateway ?? "Pay with Monero", financial: "PENDING", cancelledAt: null,
      };
      state.orders.set(String(id), o);
      send(res, 201, gqlOrder(o));
      if (b.webhook !== false) fireWebhook("ORDERS_CREATE", o);
      return;
    }
    const cancel = url.pathname.match(/^\/_mock\/orders\/(\d+)\/cancel$/);
    if (req.method === "POST" && cancel) {
      const o = state.orders.get(cancel[1]);
      if (!o) return send(res, 404, { error: "no such order" });
      o.cancelledAt = new Date().toISOString();
      o.financial = "VOIDED";
      send(res, 200, gqlOrder(o));
      fireWebhook("ORDERS_CANCELLED", o);
      return;
    }
    if (req.method === "GET" && url.pathname === "/_mock/state") {
      return send(res, 200, { webhooks: state.webhooks, orders: [...state.orders.values()] });
    }
    send(res, 404, { error: "not found" });
  })
  .listen(port, "127.0.0.1", () => console.log(`shopify mock on http://127.0.0.1:${port} (client_id=${CLIENT_ID})`));
