-- Baseline schema. Applied by `npm run migrate`, which records what it has run
-- in the schema_migrations table, so this file must never be edited once a
-- deployment has applied it. Add changes as new numbered files beside it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS merchants (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text NOT NULL,
    address       text NOT NULL,
    view_key_enc  bytea NOT NULL,          -- AES-256-GCM: 12-byte IV || 16-byte tag || ciphertext
    wallet_name   text NOT NULL UNIQUE,    -- wallet file name under monero-wallet-rpc --wallet-dir
    api_key_hash  text NOT NULL UNIQUE,    -- sha256 hex of the merchant API key (key itself never stored)
    webhook_url   text NOT NULL,
    webhook_secret text NOT NULL,          -- HMAC key handed to the merchant at signup
    restore_height bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id   uuid NOT NULL REFERENCES merchants(id),
    amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),  -- piconero
    price_amount  numeric(14,2),           -- set when fiat-denominated
    price_currency text CHECK (price_currency ~ '^[A-Z]{3}$'),  -- supported list: src/rates.ts
    rate          numeric,                 -- fiat per 1 XMR, locked at creation
    description   text NOT NULL DEFAULT '',
    subaddress    text NOT NULL,
    subaddr_index integer NOT NULL,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'detected', 'confirmed', 'expired')),
    return_url    text,                    -- buyer returns here from checkout
    metadata      jsonb,                   -- merchant data echoed in webhooks
    expires_at    timestamptz NOT NULL DEFAULT now() + interval '60 minutes',
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, subaddr_index)
);

CREATE TABLE IF NOT EXISTS payments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id    uuid NOT NULL REFERENCES invoices(id),
    txid          text NOT NULL,
    amount_atomic bigint NOT NULL,
    confirmations integer NOT NULL DEFAULT 0,
    detected_at   timestamptz NOT NULL DEFAULT now(),
    confirmed_at  timestamptz,
    UNIQUE (invoice_id, txid)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id    uuid NOT NULL REFERENCES invoices(id),
    event         text NOT NULL CHECK (event IN ('payment_detected', 'payment_confirmed')),
    payload       jsonb NOT NULL,
    attempts      integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    delivered_at  timestamptz,
    last_error    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (invoice_id, event)
);

-- Shopify bridge (see migrations/002_shopify.sql)
CREATE TABLE IF NOT EXISTS shopify_stores (
    merchant_id         uuid PRIMARY KEY REFERENCES merchants(id),
    shop_domain         text NOT NULL UNIQUE,     -- <shop>.myshopify.com
    client_id           text NOT NULL,            -- the merchant's own Dev Dashboard app
    client_secret_enc   bytea NOT NULL,           -- AES-256-GCM, same layout as view_key_enc
    access_token_enc    bytea,                    -- client-credentials token, valid 24h
    token_expires_at    timestamptz,
    payment_method_name text NOT NULL DEFAULT 'Pay with Monero',
    webhooks_registered_at timestamptz,
    last_synced_at      timestamptz,
    last_error          text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shopify_orders (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id     uuid NOT NULL REFERENCES merchants(id),
    order_gid       text NOT NULL,                -- gid://shopify/Order/<order_id>
    order_id        bigint NOT NULL,              -- numeric id, used in buyer pay links
    order_number    bigint,                       -- filled once the order is fetched
    order_name      text,
    status_page_url text,
    invoice_id      uuid REFERENCES invoices(id), -- current invoice; replaced on re-quote
    state           text NOT NULL DEFAULT 'new'
                    CHECK (state IN ('new', 'invoiced', 'paid', 'cancelled', 'ignored', 'error')),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    paid_marked_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, order_gid)
);
CREATE INDEX IF NOT EXISTS shopify_orders_state_idx ON shopify_orders (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS shopify_orders_invoice_idx ON shopify_orders (invoice_id);
CREATE INDEX IF NOT EXISTS shopify_orders_number_idx ON shopify_orders (merchant_id, order_number);
