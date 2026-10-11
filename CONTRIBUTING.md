# Contributing

Bug reports, fixes and integrations are all welcome. For anything large, open
an issue first so you do not build something that gets turned down.

Security problems go to [SECURITY.md](SECURITY.md), not the issue tracker.

## Getting set up

You need PostgreSQL, Node 22 or newer, and, for anything touching payments,
`monerod` and `monero-wallet-rpc`. Stagenet is enough and costs nothing:

```bash
monerod --stagenet
monero-wallet-rpc --stagenet --rpc-bind-port 18083 --disable-rpc-login \
  --wallet-dir ~/monero/stagenet-wallets --daemon-address 127.0.0.1:38081
```

Then:

```bash
cd gateway
cp .env.example .env     # set MONERO_NETWORK=stagenet
npm install
npm run migrate
npm test
npm run server           # and npm run worker in another shell
```

## Before you open a pull request

```bash
npm test          # unit tests
npx tsc --noEmit  # type check
npm run build     # make sure it compiles
```

The unit suite mocks the database, so it runs anywhere and executes no SQL. The
tests under `test/integration/` do execute SQL and skip unless you point them
at a database:

```bash
TEST_DATABASE_URL=postgres://umbra:umbra@127.0.0.1:5432/umbra npm test
```

If you touch any query, run them. CI does, in the job that already starts a
Postgres, alongside a clean-database migration run, PHP syntax checks on the
plugin, and a Docker build.

### Testing without coins

- `tools/shopify-mock.mjs` stands in for a Shopify store: it serves the Admin
  API calls the bridge makes and fires signed webhooks.
- `tools/webhook-receiver.mjs` verifies outgoing webhook signatures and prints
  the payloads.

A payment can be simulated by setting an invoice to `confirmed` in the
database, which is enough to exercise everything downstream of detection.

## House style

- TypeScript, strict mode, no new runtime dependencies without a good reason.
- Comments explain **why**, not what. The non-obvious constraints (the single
  wallet lock, exact amount handling, signature verification before parsing)
  are the ones worth writing down.
- Amounts are integer piconero as `BigInt`, everywhere except the API edge.
  Never use floats for money.
- Never log view keys, API keys, webhook secrets or the master key.
- Verify signatures before parsing a body, not after.
- **Never concatenate HTML by hand.** Interpolate through the `html` tagged
  template in `src/ui/html.ts`, which escapes by default, and put any URL that
  came from a merchant, a buyer or a platform through `safeUrl` before it goes
  in an `href`: escaping makes a value safe as text and says nothing at all
  about `javascript:`.
- **No inline `<script>`.** Page data reaches the browser through escaped
  `data-` attributes and behaviour lives in `/assets/*.js`. `JSON.stringify`
  does not escape `</script>`, so one interpolated string ends the block.
- **`requireAuth` and `requireSession` are not interchangeable.** The API
  authenticates with a Bearer key; the console authenticates with a session
  cookie. If a cookie ever worked on `/api/*`, every API route would become
  reachable from any site a logged-in merchant happens to visit. There is a
  test whose only job is to keep that false.
- **Wrap async route handlers in `route()`** unless they catch for themselves.
  Express 4 does not catch a rejected handler: the request hangs instead of
  answering, which is worse than an error page.

## Adding a store integration

Two shapes, depending on where the code runs:

- **The merchant's own server** (WooCommerce, WHMCS): ship a plugin that calls
  the Umbra API with the merchant's key and receives our signed webhook. The
  gateway needs nothing new.
- **A hosted platform** (Shopify, Ecwid): the gateway holds credentials and
  talks to their API. Follow `src/shopify.ts`, which keeps the platform
  specifics in one module and reuses `createInvoice()`.

Pass `return_url` so buyers get back to their order, and `metadata` so your
integration can match a webhook to its own records.

## Licensing of contributions

Changes to `gateway/` are accepted under MIT. Changes to the WooCommerce plugin
are accepted under GPL-2.0-or-later, which WordPress requires. See
[LICENSES.md](LICENSES.md).
