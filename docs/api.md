# API reference

All endpoints take and return JSON. Merchant endpoints authenticate with a
bearer token:

```
Authorization: Bearer xmr_sk_...
```

Two routes are deliberately public, because the buyer needs them and has no
key: `GET /api/invoices/:id` and the checkout page. The invoice id is the
capability, so treat the URL as a secret.

Everything under `/api/` authenticates with that Bearer key and **only** with
it. The console's session cookie is not accepted here, deliberately: if it
were, every route below would be reachable from any website a logged-in
merchant happened to be visiting.

## Accounts

### `POST /api/merchants`

Creates an account. Disabled unless `SIGNUP_TOKEN` is set, and then requires
the `X-Signup-Token` header. Limited to 5 attempts per hour per address.

| Field | Notes |
| --- | --- |
| `name` | Your shop name. |
| `address` | Your primary Monero address, matching `MONERO_NETWORK`. |
| `view_key` | Private **view** key, 64 hex characters. Never the spend key. |
| `webhook_url` | Optional. http(s), and must not resolve to a private address. Leave it out if you only use the hosted checkout page and poll instead. |

Returns `merchant_id`, `api_key`, `webhook_secret` and
`wallet_status: "provisioning"`. The key and secret are shown **once**: only a
hash of the key is stored, so a lost key cannot be recovered.

The account exists immediately, but its view-only wallet does not. Building one
holds the wallet lock for minutes, longer than a reverse proxy will keep a
connection open, and losing that response would lose the only copy of the API
key. So the worker builds the wallet on a later pass, and until it is ready
`POST /api/invoices` answers `503` with a `Retry-After` header. It usually takes
a few minutes. A deployment running the API with no worker never provisions at
all.

One address can only be registered once. A view-only wallet derives its
subaddresses from the keys, so two accounts sharing an address would mint the
same invoice subaddresses and cross-attribute each other's payments. A repeat
returns `409`.

### `GET /api/me`

Your account: name, address, webhook URL, creation time.

### `POST /api/me/webhook`

Changes where webhooks are delivered. Body: `{"webhook_url": "https://..."}`.

### `POST /api/me/rotate-secret`

Issues a new webhook secret and returns it once. **The old secret stops working
immediately**, so update your server first. A signature either verifies or it
does not, so there is no overlap to offer here.

### `POST /api/me/rotate-key`

Issues a new API key and returns it once. Unlike the webhook secret, the old
key can keep working for a while, because it is pasted into shop plugins and a
clean break would take a live shop down the moment you pressed the button.

| Field | Notes |
| --- | --- |
| `grace_minutes` | How long the old key keeps working. 0 to 10080 (7 days). Default 1440. |

```json
{
  "api_key": "xmr_sk_...",
  "previous_key_expires_at": "2026-10-12T22:00:00.000Z"
}
```

Pass `0` after a leak: the old key stops working immediately.

### `POST /api/me/revoke-previous-key`

Ends the overlap now. Returns `{"ok": true, "revoked": true}`, or
`revoked: false` if there was nothing left to revoke.

### `GET /api/me/key`

When the current key was issued, whether a previous key is still live, when it
expires, and **when it was last used**. That last field is the one that
matters: while it keeps moving, something out there still holds the old key.

## Invoices

### `POST /api/invoices`

Price in Monero or in fiat, not both. Limited to 60 per minute per account.

| Field | Notes |
| --- | --- |
| `amount_xmr` | Decimal string, up to 12 decimal places. |
| `price_amount`, `price_currency` | Fiat price. Converted at creation and the rate is then locked. |
| `description` | Free text, shown on the checkout page. |
| `expires_in_minutes` | 5 to 1440. Default 60. |
| `return_url` | Where the buyer can get back to your order after paying. |
| `metadata` | JSON object up to 4 KB, echoed in every webhook for this invoice. |

Supported currencies: USD, EUR, GBP, CAD, AUD, CHF, JPY, NZD, SEK, PLN, BRL,
INR, NOK, DKK, CZK, HUF, RON, BGN, TRY, UAH, ISK, MXN, ARS, CLP, COP, PEN, CNY,
HKD, TWD, SGD, KRW, MYR, THB, IDR, PHP, VND, BDT, PKR, LKR, ZAR, NGN, KES, GHS,
EGP, MAD, AED, SAR, QAR, ILS.

The response carries `rate_age_seconds`: normally 0, and above zero when every
rate provider was briefly unreachable and the last known rate was used. A rate
that has moved more than 50% since the last known one is treated as a bad tick
and ignored, and once no rate has been obtainable for ten minutes the request
is refused with `503` rather than quoting a guess. Both thresholds are
configurable (`RATE_JUMP_REJECT_PCT`, `RATE_MAX_STALE_MS`).

```json
{
  "invoice_id": "0c0766e8-...",
  "subaddress": "8...",
  "amount_atomic": "44186005408",
  "amount_xmr": "0.044186005408",
  "price_amount": "25.00",
  "price_currency": "USD",
  "rate": 565.8,
  "status": "pending",
  "expires_at": "2026-09-22T11:54:03.184Z",
  "checkout_url": "https://pay.example.com/checkout/0c0766e8-..."
}
```

Amounts are exact: internally everything is integer piconero, so nothing is
lost to floating point. `amount_atomic` is authoritative, `amount_xmr` is the
same number formatted.

### `GET /api/invoices/:id`

Public. Status, amounts due and received, and confirmations. This is what the
checkout page polls.

### `GET /api/me/invoices`

Your invoices, newest first. Paged: the body is still a plain array, and the
cursor for the next page arrives in a `Link` header.

| Parameter | Notes |
| --- | --- |
| `limit` | 1 to 500. Default 100. |
| `before` | An invoice id: returns the page older than it. |
| `status` | One of `pending`, `detected`, `confirmed`, `expired`. |
| `q` | Matches a description, or the start of an invoice id. |

```
Link: <https://pay.example.com/api/me/invoices?limit=100&before=0c0766e8-...>; rel="next"
```

No header means there is nothing older. Paging is keyset, not offset, so rows
are never skipped or repeated as new invoices arrive while you read.

### `GET /api/invoices/:id/webhooks`

The delivery log for one invoice: attempts, last error, delivery time.

### `POST /api/webhook-deliveries/:id/redeliver`

Puts a delivery back on the queue with its attempt count reset.

## Statuses

| Status | Meaning |
| --- | --- |
| `pending` | Created, waiting for payment. |
| `detected` | The full amount was seen at 0-conf. Fast, optimistic, not final. |
| `confirmed` | Reached the confirmation threshold (10 by default). Safe to fulfil. |
| `expired` | The window elapsed without sufficient payment. |

A detected payment can still disappear: a dropped or replaced transaction, or a
reorg. If that happens the invoice falls back to `pending` and its
`payment_detected` webhook is withdrawn before delivery. Ship goods on
`payment_confirmed`.

Underpayment leaves the invoice `pending`. Overpayment is credited to the
invoice and kept.

## Webhooks

Delivered as `POST` with the event in `X-Webhook-Event`. The first two are
always on; the rest are off until you enable them, so an integration written
against the original two is never surprised by a new one.

| Event | When |
| --- | --- |
| `payment_detected` | The full amount was seen in the mempool or a fresh block. |
| `payment_confirmed` | The payment reached the confirmation threshold. |
| `invoice_expired` | The window closed with nothing received. |
| `payment_underpaid` | The window closed with part of the money received. Fired once, at close. |
| `payment_overpaid` | More confirmed than was asked for. Carries `overpaid_xmr`. |
| `page_goal_reached` | A crowdfunding page crossed its goal. Carries `payment_page_id` and `raised`. |
| `pos_charge_accepted` | A cashier accepted a sale by hand. Carries `accepted_by_device`. |

Enable them in the console under Settings, or:

```bash
curl -X PUT https://pay.example.com/api/me/webhook-events \
  -H "Authorization: Bearer $UMBRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"events": ["invoice_expired", "payment_underpaid"]}'
```

`GET /api/me/webhook-events` lists what is enabled, what exists, and which two
cannot be switched off. Every event is at most once per invoice, enforced by a
unique constraint, and a merchant with no webhook URL has nothing queued at
all.

```
X-Webhook-Event: payment_confirmed
X-Webhook-Signature: f889d2ae...ec23a

{
  "event": "payment_confirmed",
  "invoice_id": "0c0766e8-...",
  "merchant_id": "1cf6b8b8-...",
  "amount_due_xmr": "0.044186005408",
  "amount_received_xmr": "0.044186005408",
  "price_amount": "25.00",
  "price_currency": "USD",
  "rate": "565.8",
  "txids": ["5faf1d15...99717"],
  "confirmations": 10,
  "metadata": {"order_id": 1042},
  "timestamp": "2026-09-22T11:57:10.433Z"
}
```

### Verifying

The signature is HMAC-SHA256 of the **raw body**, hex encoded. No prefix, no
timestamp. Compare in constant time and never parse an unverified body:

```js
const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
const got = req.headers["x-webhook-signature"] ?? "";
const ok = got.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
if (!ok) return res.status(401).end();
```

Frameworks that parse JSON for you will break verification if you re-serialise
the parsed object. Capture the raw body first.

### Delivery

Answer with any `2xx` once you have stored the event. Anything else is a
failure and is retried: up to 8 attempts with backoff from 10 seconds to an
hour, with a 10 second timeout per attempt. A retry can arrive after your
handler already succeeded, so make handlers idempotent.

## Errors

Errors are `{"error": "..."}` with a status that says whose problem it is.

| Status | Meaning |
| --- | --- |
| `400` | Malformed request: a bad amount, an unsupported currency, an expiry outside 5 to 1440. |
| `401` | Missing or unknown API key. |
| `403` | Signup is disabled, or the signup token is wrong. |
| `404` | No such invoice, delivery or connection, or it belongs to another account. |
| `409` | That Monero address is already registered. |
| `429` | Rate limited. `Retry-After` says for how long. |
| `500` | Our fault. The body carries a `reference` that appears in the server log. |
| `503` | Temporary: the account's view-only wallet is still being built. `Retry-After` says when to come back. |

## Payment pages

A shareable link that mints its own invoice: a pay link, a donation page or a
tip jar. Full guide in [payment-pages.md](payment-pages.md).

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/pages` | Create. Returns the page with its public `url`. |
| `GET` | `/api/pages` | List, including archived. |
| `GET`/`PATCH` | `/api/pages/:id` | Read, update. |
| `DELETE` | `/api/pages/:id` | Archives it. Nothing is deleted. |
| `GET` | `/api/pages/:slug/public` | Public. What a visitor is allowed to know. |
| `POST` | `/api/pages/:slug/charges` | Public. Mints an invoice for a chosen amount. |

Creating a page turns the subaddress pool on, because the mint happens for an
anonymous visitor and must not take the wallet lock.

`POST /api/pages/:slug/charges` takes `{"amount": "0.1", "_ticket": "..."}`,
where the ticket comes from the page's own HTML, and answers `201` with a
`checkout_url`. It answers `503` with `Retry-After` when the pool is empty or
the page has too many unfinished payments, and `403` when the ticket is
missing, stale or was issued for another page.

## Point of sale

Full guide in [pos.md](pos.md). A till authenticates with its own
`xmr_pos_...` token, never the merchant's API key.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/pos/devices` | key | Create a device. Returns a one-time enrolment code. |
| `GET` | `/api/pos/devices` | key | List devices and their state. |
| `PATCH` | `/api/pos/devices/:id` | key | Rename, change the 0-conf limit or the window. |
| `POST` | `/api/pos/devices/:id/revoke` | key | Instant. The till 401s on its next request. |
| `POST` | `/api/pos/devices/:id/enrol-code` | key | A fresh code, invalidating the old credential. |
| `POST` | `/pos/api/enrol` | none | The till swaps a code for its token. Single use. |
| `GET` | `/pos/api/device` | till | Its own settings, and nothing else. |
| `POST` | `/pos/api/charges` | till | Take a charge. |
| `GET` | `/pos/api/charges` | till | This device's last 20, so a replacement phone can resume. |
| `GET` | `/pos/api/charges/:id` | till | Poll one. |
| `POST` | `/pos/api/charges/:id/cancel` | till | Only while nothing has arrived. |
| `POST` | `/pos/api/charges/:id/accept` | till | The operator says the sale is done. Never touches `status`. |
| `POST` | `/pos/api/charges/:id/remainder` | till | A second charge for the shortfall. |

## The subaddress pool

Minting a subaddress takes the global wallet lock, because every wallet-rpc
call pays a full open / work / close cycle. That is fine for an API caller
holding a key, who is rate limited and known. It is not fine for anything an
anonymous visitor can trigger, which would let a stranger stall the merchant's
own chain scanner.

So the worker pre-mints addresses in batches and those paths claim one instead
of minting. The pool is off until something needs it (`target: 0`).

### `GET /api/me/pool`

```json
{ "target": 100, "free": 94, "total": 118 }
```

`free` falling toward zero means the worker is not keeping up, or is not
running. Routes that need the pool answer `503` with `Retry-After` when it is
empty, rather than queueing behind the lock.

### `PATCH /api/me/pool`

Body `{"target": 100}`, 0 to 10000. Set 0 to switch the pool off.

## Health

`GET /healthz` reports database status. `?deep=1` also checks wallet-rpc and
the daemon, and returns `503` while the node is still syncing.
