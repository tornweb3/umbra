=== Umbra Monero Payments for WooCommerce ===
Contributors: umbra
Tags: monero, xmr, cryptocurrency, payment gateway, privacy
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Accept Monero (XMR) non-custodially. Funds settle straight to your own wallet; Umbra never holds them.

== Description ==

Buyers choose Monero at checkout and pay from their own wallet on a hosted Umbra
checkout page (QR code plus a subaddress unique to that order). Umbra watches the
chain and tells your store when the payment confirms, which completes the order.

* Non-custodial: you share a view key, never a spend key, so Umbra can watch payments but can never move them.
* A fresh subaddress per order, so payments are matched automatically.
* Orders are priced in your store currency, with the exchange rate locked when the invoice is created.
* Signed webhooks (HMAC-SHA256) complete orders, with retries until your site responds.
* Works with both the classic and block-based checkout.

Supported store currencies: USD, EUR, GBP, CAD, AUD, CHF, JPY, NZD, SEK, PLN, BRL, INR.
The payment method hides itself automatically if your store uses another currency.

== Installation ==

1. Create an Umbra account and note your **API key** and **webhook secret** (both are shown once).
2. Upload this plugin folder to `wp-content/plugins/` and activate it.
3. Go to **WooCommerce → Settings → Payments → Umbra Monero**.
4. Enable it, then paste in your Umbra API URL, API key and webhook secret.
5. Copy the webhook URL shown on that settings screen (it looks like
   `https://yourstore.com/?wc-api=umbra_monero`) and set it as your webhook URL in Umbra.
6. Place a test order to confirm the flow end to end.

== Frequently Asked Questions ==

= When is the order marked paid? =

By default when the payment reaches the confirmation threshold (10 confirmations,
roughly 20 minutes). You can switch to 0-conf in the settings, which is instant but
reversible until confirmed; that suits instantly delivered digital goods.

= What happens while the buyer is paying? =

The order sits in **On hold**, which reserves stock. A note is added when the payment
is first seen on the network.

= What if the buyer never pays? =

The invoice expires and the order stays On hold for you to cancel. Nothing is charged.

= How do refunds work? =

Manually, from your own wallet. Umbra never holds your funds, so it cannot send a
refund on your behalf.

= Does Umbra see my customers' details? =

No. The plugin sends only the order total, currency, order number and a return link.

== Changelog ==

= 0.1.0 =
* First release: hosted Monero checkout, signed webhooks, classic and block checkout support.
