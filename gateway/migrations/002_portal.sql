-- The browser-managed merchant UI, plus the wallet provisioning it forces.
--
-- A portal account is a separate credential from the API key on purpose: the
-- key is a machine credential pasted into shop plugins, and a session that
-- doubled as one could not be revoked without taking the merchant's shop down.

CREATE TABLE IF NOT EXISTS portal_users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id         uuid NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE CASCADE,
    username            text NOT NULL UNIQUE,   -- lowercased on write; an email is a fine username
    password_hash       text NOT NULL,          -- scrypt$N$r$p$salt$hash: parameters inline so they can be raised later
    failed_attempts     integer NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    reset_token_hash    text,                   -- sha256 of a one-time token from `npm run portal:reset`
    reset_expires_at    timestamptz,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    last_login_at       timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
    -- sha256 of the cookie value. The value itself is never stored, so a
    -- read-only database leak cannot be replayed as a live session.
    token_hash   text NOT NULL UNIQUE,
    -- Synchroniser token: rendered into every form, never sent as a cookie.
    csrf         text NOT NULL,
    -- Last password re-entry. Credential changes require a recent one.
    reauth_at    timestamptz,
    user_agent   text,
    ip           text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_sessions_user_idx   ON portal_sessions (user_id);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON portal_sessions (expires_at);

-- generate_from_keys holds the wallet lock for minutes, which outlives both a
-- browser request and any reverse proxy's read timeout. Signup used to do it
-- inline, so a merchant could lose the only copy of their API key to a 504.
-- The row lands first; the worker creates the view-only wallet on a later pass.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS wallet_ready_at timestamptz;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS wallet_error    text;
-- Existing merchants were provisioned synchronously, so they are ready.
UPDATE merchants SET wallet_ready_at = created_at WHERE wallet_ready_at IS NULL;

-- A merchant using only the hosted checkout page has nowhere to deliver to,
-- and assertSafeWebhookUrl refuses the private URL they would otherwise
-- invent. The worker skips enqueueing and delivery when this is null.
ALTER TABLE merchants ALTER COLUMN webhook_url DROP NOT NULL;

-- The invoice list is always read per merchant, newest first, and paged by
-- keyset on (created_at, id). There was no index on merchant_id at all.
CREATE INDEX IF NOT EXISTS invoices_merchant_created_idx ON invoices (merchant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS invoices_merchant_status_idx  ON invoices (merchant_id, status, created_at DESC);
