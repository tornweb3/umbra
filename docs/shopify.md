# Shopify

Buyers pick **Pay with Monero** at checkout, Shopify holds the order as
pending, and Umbra marks it paid once the invoice confirms on-chain.

Shopify does not let outside payment providers into its checkout without a
partnership, so this uses a manual payment method, the same approach BTCPay
Server takes. The buyer pays just after checkout rather than inside it.

You keep control of the Shopify app: you create it, you hold its credentials,
and you can revoke it at any time. There is no OAuth and no Umbra-owned app.

## Setup

### 1. Create an app for your store

In Shopify's Dev Dashboard, choose **Create app**, then **Start from Dev
Dashboard**, and name it. Apps can no longer be created from the store admin:
that was removed on 1 January 2026.

### 2. Give it access to orders

On the app's version, select the Admin API scopes `read_orders` and
`write_orders`, then release the version. `write_orders` is what lets Umbra
mark an order paid.

### 3. Install it on your store

From the app's Home page choose **Install app** and pick your store. The app
and the store must belong to the same Shopify organization, which is what lets
Umbra get tokens without an OAuth flow.

### 4. Connect it to Umbra

Copy the Client ID and Client secret from the app's Settings:

```bash
curl -X PUT https://pay.example.com/api/me/shopify \
  -H "Authorization: Bearer $UMBRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "shop_domain": "your-store.myshopify.com",
    "client_id": "<Client ID>",
    "client_secret": "<Client secret>"
  }'
```

Umbra verifies the credentials, subscribes to your order webhooks, and returns
the text for the next two steps. The client secret is stored encrypted.

### 5. Add the payment method

In your Shopify admin: **Settings → Payments → Manual payment methods →
Create custom payment method**. Name it exactly **Pay with Monero**, and paste
in the `payment_instructions` from the previous step.

The name must match what Umbra expects. If you want a different one, pass
`payment_method_name` when connecting.

### 6. Add the pay button to your emails

In **Settings → Notifications → Order confirmation**, choose **Edit code** and
paste in the `email_snippet`. It links to a payment page using Shopify's
internal order id, which cannot be guessed from the order number.

## What happens to each order

| | |
| --- | --- |
| Order placed | Shopify holds it as Payment pending. Umbra invoices it in the order's currency with the rate locked. |
| Buyer pays | From the email button, or at `/shopify/pay/<shop>` with their order number. |
| Payment confirmed | Umbra marks the order Paid through the Admin API. |
| Order cancelled | The unpaid invoice is withdrawn, so nobody can pay a cancelled order. |
| Invoice expired | Opening the pay link again issues a fresh quote at the current rate. |
| Partial payment | Never re-quoted automatically. The buyer is asked to contact you, so what they sent is not stranded. |

Orders arrive two ways: a signed `orders/create` webhook, and a poll of recent
pending orders every two minutes. The poll exists because Shopify deletes a
webhook subscription after 8 failed deliveries, so an outage would otherwise
strand orders silently.

## What Umbra stores

Each order's number, total, status and order-page link. Not customer names,
emails or addresses. Orders paid by card never reach the queue at all: the
webhook payload names the payment method, so they are dropped on arrival.

## Managing the connection

```bash
curl https://pay.example.com/api/me/shopify -H "Authorization: Bearer $UMBRA_API_KEY"
curl -X DELETE https://pay.example.com/api/me/shopify -H "Authorization: Bearer $UMBRA_API_KEY"
```

The status call shows the connection and your 25 most recent orders with their
state. Disconnecting stops processing immediately; the orphaned webhook
subscriptions then fail and Shopify removes them.

## Requirements and limits

- `PUBLIC_BASE_URL` must be the final HTTPS host. Shopify treats a redirect,
  including bare domain to `www`, as a failed delivery.
- Your store currency must be one Umbra can price. See
  [the API reference](api.md).
- Refunds are sent from your own wallet. Umbra never holds funds.

## Testing without a store

`gateway/tools/shopify-mock.mjs` serves the Admin API calls the bridge makes
and fires signed webhooks, so the whole flow can be exercised locally:

```bash
node tools/shopify-mock.mjs 4100
SHOPIFY_TEST_API_BASE=http://127.0.0.1:4100 npm run server
curl -X POST localhost:4100/_mock/orders -d '{"amount":"25.00","currency":"USD"}'
```
