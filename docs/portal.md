# The merchant console

The gateway serves its own console at `/portal`. No second service, no build
step, no JavaScript framework: plain server-rendered pages from the same
process that serves the checkout page.

## First run

Open the gateway in a browser. `/` sends you to `/portal`, which sends you to
`/portal/setup` while the gateway has no account.

Setup is open only while **no console account exists**, and only to a request
that either comes from a private address with no reverse proxy configured, or
carries `SIGNUP_TOKEN`. That second condition matters more than it looks:
behind nginx with `TRUST_PROXY` unset, every request on earth appears to come
from `127.0.0.1`, so a private-address check on its own would hand the gateway
to the first stranger who loaded it.

If setup refuses, the page tells you the two ways in: an SSH tunnel to the
machine, or `SIGNUP_TOKEN` in `.env` and `/portal/setup?token=...`.

Two ways to finish:

- **New account.** Shop name, primary address, private view key, optional
  webhook URL, and a console username and password. Your API key and webhook
  secret are shown once, in the response to that form.
- **I already have an API key.** For an account created through the API before
  the console existed. The key proves the account is yours, is used once, and
  is not stored by that flow.

Either way, the view-only wallet is built by the worker afterwards, so the
overview page shows "preparing" for a few minutes and invoice creation answers
`503` until it is ready. A deployment running the API with no worker never
finishes provisioning, and the page says so rather than spinning.

## Two credentials, on purpose

| | API key | Console password |
| --- | --- | --- |
| Used by | shop plugins, your own code | you, in a browser |
| Sent as | `Authorization: Bearer` | a session cookie |
| Revocable | rotation breaks whatever holds it | log out, or log out everywhere |
| Expires | never | 12 hours idle, 7 days absolute |

They are never interchangeable. **A session cookie does not authenticate
`/api/*`**, and that is deliberate: if it did, every API route would be
reachable from any site you happened to be visiting while logged in, including
the one that changes where your webhooks are delivered. There is a test whose
only job is to keep that true.

## What protects the console

- Passwords are hashed with scrypt at 32 MiB, with the cost parameters stored
  alongside each hash so they can be raised later without locking anyone out.
- Sessions live in the database and only `sha256(token)` is stored, so a
  read-only database leak cannot be replayed as a live session.
- The session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` whenever the
  request is effectively HTTPS. It is deliberately not `Secure` on a
  plain-HTTP localhost first run, because that would drop the cookie and loop
  the login page forever.
- Every form carries a per-session CSRF token, and a cross-site `Origin` is
  refused before the token is even compared.
- Five failed logins lock the account for 15 minutes, doubling up to a day. A
  wrong username costs the same time as a wrong password, so the response does
  not say which accounts exist.
- Changing a credential will require the password again, within ten minutes.
- The pages send `no-store`, `X-Frame-Options: DENY`, `noindex`, and a CSP with
  no `unsafe-inline`.

## Forgotten password

The operator of a self-hosted gateway has shell access by definition, so
recovery does not need a mail server:

```bash
npm run portal:reset -- your-username     # or: npm run start:portal-reset -- your-username
```

It prints a one-time URL, valid for an hour, and never a password. Setting the
new password ends every other session, since a reset is how someone recovers
from a compromise.

## The pages

**Overview.** What the account received in the last 30 days, how many invoices
are confirmed, awaiting confirmations and awaiting payment, the payout address
and webhook URL, and a banner when something needs attention: a wallet still
being prepared, a wallet that failed to prepare, or no webhook URL configured.

**Invoices.** Newest first, 25 to a page, filtered by status or by a search
over descriptions and invoice ids. Paging is keyset, so nothing is skipped or
repeated while you read.

**One invoice.** Amounts due and received, the locked fiat rate, the
subaddress, the checkout link, every payment with its transaction id and
confirmations, and the webhook delivery log with a Redeliver button per row.
Redelivery resets that delivery's attempt count so the worker picks it up on
its next pass.

The checkout link on that page is a capability: anyone holding it can see the
invoice, so it is treated as a secret and the page says so.

**New invoice.** Price in XMR or in one of the 12 fiat currencies, with the
rate locked at creation. Creating an invoice mints a subaddress, which takes
the wallet lock, so the form is rate limited per account and refuses while the
wallet is still being prepared.

**Pages.** Create and edit payment pages, copy the public link, and archive
or reopen one. Described in [payment-pages.md](payment-pages.md).

**Point of sale.** Enrol a till by showing it a QR code, see which devices
are in use, revoke one instantly, or issue it a fresh code. Described in
[pos.md](pos.md).

**Settings.** The webhook URL, webhook secret rotation, API key rotation and
revocation, the console password, and the list of active sessions.

Every one of those requires the password again, within the last ten minutes,
and until it is entered the page shows the values but offers no form. A stolen
session alone cannot change where your webhooks are delivered.

Rotating the API key keeps the old one alive for a window you choose (an hour,
a day, a week, or not at all). While that window is open the page tells you
whether anything is still using the old key, which is what makes it safe to
revoke deliberately rather than hopefully:

> Something is still using the old key, last seen 40 seconds ago. Find it and
> paste the new key there before revoking.

and once it goes quiet, that it is safe. Rotating the key does not change the
webhook secret, does not log you out, and does not affect existing invoices or
their checkout links; the page says so, because the three buttons sit next to
each other.

New keys and secrets are rendered in the body of the POST that created them,
never in a redirect: a query string reaches proxy logs, browser history and
`Referer`.

**Status.** What to look at when something seems stuck, in the order it is
usually wrong:

- **Is the worker running?** An API with no worker looks exactly like a quiet
  one: nothing is scanned, no webhook is delivered, no wallet is prepared. The
  worker now records a heartbeat at the end of every pass, and this page says
  how long ago that was, how long the pass took, and what it reported if it
  failed. If it has not run in four poll intervals, the page says so and gives
  the command to start it.
- **Is the node synced?** A syncing node is shown as not ready, because
  payments in blocks it has not seen yet cannot be detected.
- **Is anything queued?** Invoices awaiting payment, payments awaiting
  confirmations, webhooks retrying, wallets still being prepared.
- **What is this?** Version, network, public base URL, confirmation threshold,
  poll interval, and the migration history.

The deep probes are cached for ten seconds, so reloading the page does not
hammer your node. An unreachable service is reported on the page rather than
failing it: the page's whole job is to work when other things do not.

The Shopify connection is still API-only, documented in
[the Shopify guide](shopify.md).
