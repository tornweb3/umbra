-- Payment pages: a pay link, a donation page, a tip jar, a crowdfunding goal.
--
-- The thing none of these can do is mint on a page view. Minting takes the
-- wallet lock (see 005), and a link unfurler, a mail scanner or a prefetcher
-- would fire a GET on every page that was ever shared. So a page is static
-- until a visitor commits to an amount, and then it claims from the pool.

CREATE TABLE IF NOT EXISTS payment_pages (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id   uuid NOT NULL REFERENCES merchants(id),
    -- Globally unique, so the public URL is one short segment and carries no
    -- merchant identifier. Generated with a random suffix.
    slug          text NOT NULL UNIQUE
                  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
    page_type     text NOT NULL
                  CHECK (page_type IN ('fixed', 'donation', 'tip', 'crowdfund')),

    -- Every amount below is in XMR when price_currency IS NULL, and in that
    -- fiat currency otherwise. numeric, never float: pg hands these back as
    -- strings, which is exactly what atomicFromXmr wants.
    price_currency text CHECK (price_currency ~ '^[A-Z]{3}$'),
    amount_fixed   numeric(24,12) CHECK (amount_fixed > 0),
    amount_min     numeric(24,12) CHECK (amount_min > 0),
    amount_max     numeric(24,12) CHECK (amount_max > 0),
    suggested      jsonb,                  -- ["5","10","25"], decimal strings

    goal_amount     numeric(24,12) CHECK (goal_amount > 0),
    goal_reached_at timestamptz,           -- set once, so the event fires once
    -- Cache of the public total, maintained by the worker. invoices is the
    -- truth; these exist so an anonymous page view is a single-row read.
    raised_confirmed numeric(24,12) NOT NULL DEFAULT 0,
    supporter_count  integer NOT NULL DEFAULT 0,
    progress_at      timestamptz,
    progress_visibility text NOT NULL DEFAULT 'public'
                  CHECK (progress_visibility IN ('public', 'percent_only', 'private')),

    title         text NOT NULL,
    description   text NOT NULL DEFAULT '',   -- plain text, newlines kept, not markdown
    cta_label     text NOT NULL DEFAULT 'Pay with Monero',
    success_message text NOT NULL DEFAULT '',
    accent_color  text CHECK (accent_color ~ '^#[0-9a-fA-F]{6}$'),
    return_url    text,

    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    closes_at     timestamptz,
    invoice_expiry_min integer NOT NULL DEFAULT 30
                  CHECK (invoice_expiry_min BETWEEN 5 AND 1440),
    -- Durable backstop against junk: refuse to mint when this many of the
    -- page's invoices are live and unpaid. Self-healing, because page invoices
    -- expire in invoice_expiry_min.
    max_live_invoices integer NOT NULL DEFAULT 500 CHECK (max_live_invoices > 0),

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- Shape per type, enforced here so no code path can write a bad row.
    CHECK (page_type <> 'fixed' OR amount_fixed IS NOT NULL),
    CHECK (page_type <> 'crowdfund' OR goal_amount IS NOT NULL),
    CHECK (amount_max IS NULL OR amount_min IS NULL OR amount_max >= amount_min)
);
CREATE INDEX IF NOT EXISTS payment_pages_merchant_idx ON payment_pages (merchant_id, created_at DESC);

-- A real foreign key, not a key inside invoices.metadata: metadata is
-- merchant-writable through the public API, so a merchant could point it at
-- another merchant's page and poison a public total. This column is written by
-- exactly one code path and cannot be forged.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_page_id uuid REFERENCES payment_pages(id);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'api'
    CHECK (source IN ('api', 'shopify', 'page', 'pos'));
-- Part of amount_atomic, split out so a receipt can show it.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tip_atomic bigint NOT NULL DEFAULT 0
    CHECK (tip_atomic >= 0);

CREATE INDEX IF NOT EXISTS invoices_page_idx ON invoices (payment_page_id)
    WHERE payment_page_id IS NOT NULL;
-- The per-page live cap reads exactly this.
CREATE INDEX IF NOT EXISTS invoices_page_live_idx ON invoices (payment_page_id, status)
    WHERE status = 'pending';
