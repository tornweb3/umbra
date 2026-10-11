# Security

Umbra handles payments, so please report problems privately first.

## Reporting a vulnerability

Open a [private security advisory](../../security/advisories/new) on GitHub, or
email **security@umbra.international**. Please do not open a public issue for
anything exploitable.

Include what you need to show the problem: affected version or commit, what an
attacker gains, and the steps to reproduce. A working proof of concept helps
but is not required.

You can expect an acknowledgement within 72 hours and an assessment within a
week. If a fix is needed we will agree a disclosure date with you, and credit
you unless you would rather stay anonymous.

## What is in scope

Anything in `gateway/` or `integrations/`, including:

- payment detection, confirmation and amount handling
- authentication, the signup gate, and rate limits
- webhook signing and signature verification
- handling of view keys, API keys and the master key
- anything that lets one merchant reach another merchant's data

Out of scope: vulnerabilities in Monero itself, in `monero-wallet-rpc`, in
PostgreSQL, or in a deployment's own reverse proxy and server configuration.
Those belong upstream.

## The trust model, stated plainly

Umbra holds **view keys only**. Compromising it exposes payment history and
lets an attacker see incoming payments. It does not let them spend, because
the spend key never reaches the system.

### Two credentials, and what each one can do

The API key is a machine credential: it is pasted into shop plugins and
whatever else the merchant runs. The console password is a human credential
and gets a revocable session cookie. They are never interchangeable, and in
particular **a session cookie does not authenticate `/api/*`**: if it did,
every API route would be reachable from any site a logged-in merchant visited.

A stolen **session cookie** can read the merchant's invoices, create an
invoice, and requeue a webhook delivery. It cannot change the webhook URL,
rotate the webhook secret, rotate the API key or change the password, because
each of those asks for the password again and only accepts it within the last
ten minutes. Logging out, or changing the password, revokes it server-side.

A stolen **API key** can create invoices and read invoice history. Rotate it
with `POST /api/me/rotate-key`, or from the console, which keeps the old key
alive for a window you choose so a live shop does not break mid-rotation and
tells you whether anything is still using it.

Neither can move funds. Umbra holds a view key.

What a compromise does put at risk:

- **The master key plus the database** together reveal every stored view key,
  which means full visibility of merchants' incoming transactions. Keep them
  separate where you can, and back the key up somewhere the database is not.
- **API keys** let an attacker create invoices and read invoice history for
  that merchant.
- **Webhook secrets** let an attacker forge a "payment confirmed" call to a
  merchant's shop, which is how fake orders get fulfilled. Rotate them with
  `POST /api/me/rotate-secret` if one leaks.

## Running it safely

- Keep `monerod` and `monero-wallet-rpc` off the public internet.
- Terminate TLS in a reverse proxy; the gateway speaks plain HTTP and binds to
  loopback by default.
- Leave `ALLOW_PRIVATE_WEBHOOKS` off outside local testing. It disables the
  check that stops a webhook URL reaching inside your own network.
- Leave `SIGNUP_TOKEN` unset once your merchant accounts exist.
- Back up the database and the wallet directory together, and test a restore.

## Status

This project is young and has not had an independent security audit. Run it on
stagenet first and with amounts you can afford to lose until you have satisfied
yourself it behaves.
