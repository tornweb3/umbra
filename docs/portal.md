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

## What is here so far

The overview page: the account, its payout address, webhook URL and wallet
state, with a banner when something needs attention. Invoices, settings,
credential rotation and the Shopify connection are next; the API does all of it
today, documented in [the API reference](api.md).
