# Point of sale

A till that runs in a browser on whatever phone or tablet is behind the
counter, on the same gateway and the same ledger as the website. Sales from the
counter and sales from the shop end up in one place.

## Enrolling a till

In the console: **Point of sale → Add a device**. Name it, choose the currency
the cashier will type in, and set the 0-conf limit (see below). The console
then shows a QR code once.

Scan it with the till. That is the whole setup.

**The merchant's API key never reaches the phone.** A counter phone gets
lost, borrowed and stolen, and a key on it could not be revoked without taking
the shop's own integration down at the same time. So the QR carries a one-time
enrolment code that the till swaps for its own credential, and the code lives
in the part of the URL after the `#`, which browsers never send to a server, so
it does not appear in any access log on the way.

A till's credential can create and act on its own charges and read its own
settings. It cannot read the merchant's other invoices, change the webhook URL,
rotate anything, enrol another device, or raise its own 0-conf limit.

## If a phone is stolen

Revoke it in the console. It stops working on its very next request, with no
worker involved and nothing else affected.

There is no PIN on the till, deliberately: the credential sits in that phone's
browser storage either way, so a PIN on the page is theatre. What matters is
that revocation is instant, the scope is narrow, and **no amount of access to a
till can move funds**, because this gateway holds a view key and not a spend
key. A till built on a custodial processor cannot say that.

## The 0-conf limit, which is a risk budget

A Monero payment with no confirmations is fast and reversible. Waiting for
confirmations is safe and takes about twenty minutes. Which trade a merchant
wants depends on what they sell, so the gateway does not choose: the default is
**zero**, meaning every sale waits for confirmations, and raising it is a
deliberate act.

The limit is set in money, because that is how a cashier thinks about risk:
"take the risk on a coffee, not on a laptop". It is evaluated once, when the
charge is created, and **frozen onto that charge**. Two reasons:

- A policy consulted at display time could flip in the middle of a payment.
- A limit denominated in XMR would silently re-price itself as the market
  moved. A merchant who set "accept under 0.2 XMR" at $150 per XMR has doubled
  their real exposure at $300 without touching anything.

If the gateway cannot get an exchange rate to make the comparison, the answer
is no. Failing closed costs the merchant a few seconds; failing open costs them
the goods.

## At the counter

Type the amount, press **Charge**, turn the phone around or open the customer
link on a second screen. The customer view is the ordinary checkout page, so it
is the same QR and the same status a buyer would see online.

| | |
| --- | --- |
| **Paid in full** | The till says so as soon as the policy above allows. |
| **Short** | "Short by 0.004 XMR", with two choices. |
| **Charge the difference** | A second charge for the shortfall, linked to the first. The original is never rewritten: its QR is already in the customer's wallet, and its rate is already locked. |
| **Accept as paid** | Records that *you* decided the sale is done, for a waived shortfall or cash on top. |
| **Overpaid** | Credited in full. Refunds come from the merchant's own wallet; there is no refund button, because the gateway holds no funds to refund from. |
| **Cancel** | Only while nothing has arrived. Once a payment is on its way it is going to land, so cancelling would be a lie. |

**"Accept as paid" is never written to the invoice's status.** The status is a
statement about the chain and a till does not get to make one. The acceptance
is recorded separately, so the ledger can always tell "the chain confirmed
this" from "the cashier decided this", for as long as the records exist.

## Offline

The till shows an unmissable banner, the last status it managed to fetch, and
nothing else. **It never claims a payment succeeded from local state**: offline
means the cashier genuinely cannot verify, and the honest answer is to say so.

The customer's payment does not involve the till at all, so it still reaches
the merchant's wallet and the invoice still confirms on its own. The open
charge is kept in the browser, so a reload or a flat battery resumes the same
screen, and a replacement phone can list the device's recent charges to find a
sale that was open when the first one died.

## Receipts

Every charge has a printable receipt at `/pos/receipt/<invoice id>`: amount,
tip if there was one, status, transaction ids, and a QR back to the invoice so
the customer keeps proof that does not depend on the merchant's records. The
invoice id is the capability, as it is everywhere else here.

**Bluetooth receipt printing is not built in.** Web Bluetooth is Chromium-only
and absent from iOS Safari, so it would not work for a large share of counter
phones, and ESC/POS byte quirks differ per printer, which is an open-ended
device-compatibility project inside a gateway whose job is money correctness.
The printable page reaches any ordinary print path, and `GET /api/invoices/:id`
is a documented contract for anyone who wants to build a bridge.

## Known limits

- Latency to a detected payment is bounded by the worker's poll interval, so a
  busy counter wants `POLL_INTERVAL_MS` lower than the default 15 seconds.
- Tills on different merchants on one gateway still serialise behind a single
  `monero-wallet-rpc`.
- Tips are charged as part of the amount; a percentage keypad is not built yet.
