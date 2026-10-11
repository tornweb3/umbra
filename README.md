# Umbra

**[umbra.international](https://www.umbra.international)**

A self-hosted Monero payment gateway. You give it your wallet address and your
**private view key**, never your spend key. It mints a fresh subaddress for
every invoice, watches your own node for payments to it, and calls your server
when one arrives.

Because a view key can only read, the money lands in your wallet and stays
there. Umbra can see payments. It cannot move them, freeze them, or hand them
to anyone else, and neither can anyone who compromises it.

```
customer  ──pays──▶  subaddress (your wallet)
                          │
   your node ──watches────┘
        │
     Umbra ──signed webhook──▶  your shop
```

> **Status: early.** Working and tested, but young and not independently
> audited. Run it on stagenet first, start with small amounts, and read
> [SECURITY.md](SECURITY.md) before putting real money through it.

## What you get

- **Non-custodial by construction.** View key only. No hot wallet, no float, no
  withdrawal step.
- **A subaddress per invoice**, so payments match themselves. No payment IDs to
  chase, no manual reconciliation.
- **Fiat pricing** in 12 currencies with the exchange rate locked when the
  invoice is created.
- **Two webhooks**: `payment_detected` at 0-conf and `payment_confirmed` at the
  confirmation threshold, each signed with HMAC-SHA256 and retried with backoff
  until your server answers.
- **A hosted checkout page** with a QR code, or build your own from the API.
- **A merchant console in the browser**, served by the gateway itself: set the
  gateway up, read your invoices and their webhook delivery log, rotate
  credentials, and see whether the worker and your node are healthy. No
  terminal, no second service.
- **Store integrations**: WooCommerce (a plugin you install) and Shopify (via a
  manual payment method).

## Requirements

- Your own `monerod` and `monero-wallet-rpc`. A public node works for testing,
  but it can see which blocks you ask for, which defeats the point.
- PostgreSQL 14 or newer.
- Node.js 22 or newer, or Docker.

## Quick start

```bash
git clone https://github.com/tornweb3/umbra.git && cd umbra/gateway
cp .env.example .env
# Generate the key that encrypts stored view keys, and keep a backup of it:
openssl rand -hex 32
```

Fill in `.env`, at minimum `DATABASE_URL`, `MASTER_KEY`, `WALLET_PASSWORD`,
`PUBLIC_BASE_URL`, and the two Monero RPC URLs. Then:

```bash
docker compose up -d          # Postgres, API and worker; migrations run on start
curl localhost:3000/healthz
```

Without Docker:

```bash
npm install
npm run migrate               # create the schema
npm run build
npm run start:server          # the API
npm run start:worker          # the chain watcher, in a second process
```

Run exactly one worker. `monero-wallet-rpc` keeps a single wallet open at a
time, so a second one would only contend for the same lock.

### Create your merchant account

Open `http://localhost:3000` and follow the setup page. It asks for your shop
name, your primary address, your private view key and a password for the
console, and it shows your API key and webhook secret once, because only a hash
of the key is stored and a lost key can be rotated but never recovered.

Setup is open only while the gateway has no account, and only to a request from
the machine it runs on. If you are reaching it through a reverse proxy, either
tunnel in:

```bash
ssh -L 3000:127.0.0.1:3000 you@your-server
```

or open it deliberately by setting `SIGNUP_TOKEN` in `.env`, restarting, and
visiting `/portal/setup?token=<your token>`.

Your view-only wallet is built by the worker on its next pass, because that
call holds the wallet lock for minutes and would time out a browser. Invoice
creation answers `503` until it is ready.

If you already have an account from the API and want the console, choose
**I already have an API key** on the setup page.

Headless alternative, if you would rather not use a browser at all:

```bash
# set SIGNUP_TOKEN in .env, restart, then:
curl -X POST https://pay.example.com/api/merchants \
  -H "X-Signup-Token: $SIGNUP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Shop",
    "address": "4...",
    "view_key": "...",
    "webhook_url": "https://myshop.com/umbra/webhook"
  }'
```

`webhook_url` is optional: leave it out if you only use the hosted checkout
page. Lost the console password? On the server: `npm run portal:reset -- <username>`.

## Using the API

Create an invoice, send the buyer to `checkout_url`, settle on the webhook:

```bash
curl -X POST https://pay.example.com/api/invoices \
  -H "Authorization: Bearer $UMBRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"price_amount": "25.00", "price_currency": "USD",
       "return_url": "https://myshop.com/orders/1042",
       "metadata": {"order_id": 1042}}'
```

Verify every webhook before trusting it. The signature is HMAC-SHA256 of the
**raw body**, hex encoded, in `X-Webhook-Signature`:

```js
const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
const got = req.headers["x-webhook-signature"] ?? "";
const ok = got.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
if (!ok) return res.status(401).end();
```

Full reference: [`docs/api.md`](docs/api.md). The console is described in
[`docs/portal.md`](docs/portal.md).

## Integrations

| Platform | How it works |
| --- | --- |
| [WooCommerce](integrations/woocommerce) | A plugin you install. Buyers pick Monero, the order is held, and the signed webhook completes it. |
| Shopify | A manual payment method plus a store connection. Umbra marks the order paid through the Admin API. See [`docs/shopify.md`](docs/shopify.md). |

## Configuration

Everything is environment variables, documented in
[`gateway/.env.example`](gateway/.env.example). The ones worth knowing:

| Variable | Why it matters |
| --- | --- |
| `MASTER_KEY` | Encrypts stored view keys. Back it up. Lose it and every stored key becomes undecryptable. |
| `PUBLIC_BASE_URL` | Must be the final HTTPS host. A redirect from the bare domain to `www` counts as a failed webhook delivery. |
| `SIGNUP_TOKEN` | Account creation is disabled unless set. |
| `CONFIRMATIONS` | Confirmations before a payment is final. Default 10. |
| `TRUST_PROXY` | Set behind a reverse proxy so rate limits see the real client. |
| `ALLOW_PRIVATE_WEBHOOKS` | Leave off. It disables the check that stops webhooks reaching inside your network. |
| `PORTAL_DISABLED` | Set to `1` for an API-only deployment, and the console is not served at all. |
| `SESSION_TTL_HOURS` | Console session idle timeout, 12 by default, with a 7-day absolute cap. |

## Running it safely

- **Put a TLS-terminating reverse proxy in front.** The gateway binds to
  loopback by default and speaks plain HTTP.
- **Back up two things**: the database, and the `monero-wallet-rpc` wallet
  directory. The database holds encrypted view keys and invoice history; the
  wallet files hold the subaddress indexes that map payments to invoices.
- **Watch `/healthz`.** `?deep=1` also checks wallet-rpc and the daemon, and
  reports unhealthy while the node is still syncing. For a human, the console's
  Status page says the same things plus whether the worker is actually running,
  which is the usual answer when something looks stuck.
- **Keep wallet-rpc and the daemon off the public internet.**

## Known limits

- One `monero-wallet-rpc` means merchants are scanned one after another. This
  is fine for a shop or a handful of them, and it is the first thing to change
  for a large multi-merchant deployment.
- Incoming transfer amounts come from wallet-rpc as JSON numbers, so a single
  payment above roughly 9000 XMR would lose precision.
- Refunds are something you send yourself, from your own wallet. Umbra never
  holds funds and cannot refund on your behalf.
- The console is one account per gateway: one merchant, one login. Several
  merchants on one gateway is an API-only arrangement today.
- The Shopify connection is managed through the API rather than the console.
- **No real mainnet payment has been processed yet.** Everything here has been
  exercised against stagenet and against mocks; the first mainnet settlement
  happens when the dedicated node is up.

## Development

```bash
npm install
npm run migrate
npm run server     # API with reload
npm run worker     # chain watcher
npm test           # unit tests
```

`gateway/tools/` holds a mock Shopify store and a webhook receiver, so the
integrations can be exercised without a real store or real coins.

The unit tests mock the database and run anywhere. The tests in
`gateway/test/integration/` execute real SQL and skip unless you give them a
database:

```bash
TEST_DATABASE_URL=postgres://umbra:umbra@127.0.0.1:5432/umbra npm test
```

## Support the project

Umbra is free and takes no cut of anything it processes. If it is useful to
you, donations keep the work going:

```
41z6wqBLsH9KJ2deZ69H4B6xe6UUzccZfeeHPRY7X6bzLKDVKgLHS3VECT6484FXUhhhkRGzFyc9h1D6Q3rU8fj99QNZNvy
```

Monero, mainnet. The same address, with a QR code, is on
[umbra.international](https://www.umbra.international).

## License

MIT, except the WooCommerce plugin, which is GPL-2.0-or-later because WordPress
requires it. See [LICENSES.md](LICENSES.md).
