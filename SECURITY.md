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
