# Payment pages

A link anyone can open and pay, with no account, no checkout to build and no
code. Each payment still mints its own subaddress and settles into the
merchant's own wallet, exactly like an API invoice.

Three kinds today:

| Type | What the visitor sees |
| --- | --- |
| `fixed` | One amount, already filled in. A pay link for a single thing. |
| `donation` | Suggested amounts and a free field. |
| `tip` | The same, framed as a tip. |
| `crowdfund` | A goal, with public progress towards it. |

## Creating one

In the console: **Pages → New page**. Or over the API:

```bash
curl -X POST https://pay.example.com/api/pages \
  -H "Authorization: Bearer $UMBRA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "page_type": "donation",
    "title": "Help the Cat Shelter",
    "description": "Food, vet bills, and a warm place to sleep.",
    "suggested": ["0.05", "0.1", "0.25"],
    "amount_min": "0.01",
    "cta_label": "Donate Monero"
  }'
```

The response carries the public `url`. Price in XMR by leaving
`price_currency` out, or in any of the supported fiat currencies, in which case
the rate is locked when the visitor commits rather than when you create the
page.

`GET /api/pages`, `GET`/`PATCH /api/pages/:id`, and `DELETE /api/pages/:id`
round it out. The delete archives: the link stops accepting payments and
nothing is removed, because invoices point at the page and what somebody paid
for is worth more than a tidy table. Archived pages can be reopened.

## Sharing it

The link is one segment: `https://pay.example.com/p/help-the-cat-shelter-h2ym1a`.
The random suffix is deliberate, so nobody has to win a race for "donate" and
the URL is not guessable from a shop's name.

To put it on a website, that is all you need:

```html
<a href="https://pay.example.com/p/help-the-cat-shelter-h2ym1a">Donate Monero</a>
```

Optionally, add this once anywhere on the page and that link opens in a small
window instead of navigating away:

```html
<script src="https://pay.example.com/embed/v1.js" async></script>
```

It is under 2 KB, makes no network calls, touches no storage and no cookies,
and does nothing to the page beyond the Umbra links on it. If the popup is
blocked the link simply navigates as before, and if the script fails to load
nothing happens at all.

**There is no iframe, and that is deliberate.** The payment page shows an
address a visitor is about to send irreversible money to. Inside a frame they
cannot see which origin produced that address, which removes the one check they
can actually perform. It would also mean this gateway being down renders as a
broken hole in the middle of your page rather than an ordinary link.

**There is no "donations raised" badge image either.** It would look lovely and
it would put a request to this server in front of every visitor to every page
carrying it, which is a third-party tracking surface run by a privacy project.
If you want live progress on your own page, read
`GET /api/pages/:slug/public` from your own code and decide what your visitors'
browsers talk to.

## What the page does, and does not do

- **No JavaScript.** The form posts, the server mints, and the response is a
  redirect to the checkout page. A visitor with scripts blocked, which
  describes a fair share of this audience, gets exactly the same experience.
  The page's CSP has no `script-src` at all.
- **Nothing is minted on a page view.** Minting is a POST, which is a
  correctness requirement rather than a convention: a GET that minted would be
  fired by every link unfurler, mail scanner and prefetcher that ever saw the
  URL.
- **No visitor is recorded.** No IP, no salted hash of one, nothing. The
  per-visitor limit on minting is in memory and resets when the gateway
  restarts, which is an honest trade: it slows one abuser and does nothing
  against a distributed one. The durable backstop is the page's own
  `max_live_invoices`, and page invoices expire, so a flood drains itself.
- **No captcha.** The usual answer, and refused: it would put a third-party
  surveillance script on the donation page of a privacy product. The page
  carries a signed ticket instead, which forces one page fetch per mint. That
  is not a strong control and is not pretending to be.

## Crowdfunding, and what it publishes

A `crowdfund` page carries a `goal_amount` and shows progress. Three rules
decide what a stranger can learn, and each of them is deliberate:

- **Only confirmed payments count.** That is the whole answer to what a dropped
  0-conf payment does to a public figure: nothing, because it was never in it.
  A public number that can fall looks like fraud, and the size of the fall
  would publish the exact amount of the dropped transaction.
- **Each payment is valued at its own invoice's locked rate**, not at today's
  rate. Re-valuing accumulated XMR every minute would make a fiat total wander
  with the market, and fall while nothing was refunded.
- **The supporter count is hidden below five.** With a handful of supporters,
  an individual amount can be recovered by subtracting the others.

`progress_visibility` chooses between the amount and the goal (`public`), a
percentage only (`percent_only`), or nothing at all (`private`).

There is no donor wall and no per-donation list. An amount with a timestamp is
a fingerprint, and it would also be an unbounded moderation liability on
someone else's donation page. Names and messages, if you collect them, are
visible to you alone.

```bash
curl https://pay.example.com/api/pages/new-cattery-roof-jlcztq/progress
{"goal":"2.5","raised":"0.5","percent":20,"supporters":0,"goal_reached":false,"as_of":"..."}
```

The worker recomputes from the invoices behind the page, so the cached figure
on the page is never the source of truth and cannot drift permanently.

## Why it needs the subaddress pool

Minting a subaddress takes the global wallet lock, so a page that minted per
visitor could stall the merchant's own chain scanner. Pages therefore claim a
pre-minted address, and creating your first page turns the pool on
automatically. If the pool is ever empty the page answers 503 with
`Retry-After` and says "payments are warming up", which is a bounded failure
that fixes itself on the worker's next pass. See [the API reference](api.md).

## Limits worth knowing

- One account per gateway today, so pages belong to that account.
- A page in a fiat currency needs that currency to be one Umbra can price.
- Descriptions are plain text with line breaks kept, not markdown: a parser is
  a dependency and an HTML-injection surface for the sake of a `<p>`.
- Branding is a title, a description, a button label and an accent colour.
  There are no logo uploads, which would mean multipart handling, storage,
  moderation and a wider CSP for something an `<img>` on your own site already
  does.
