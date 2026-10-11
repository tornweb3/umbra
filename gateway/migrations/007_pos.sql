-- Point of sale: a till that runs in a browser on a phone behind a counter.
--
-- The device gets its own credential, never the merchant's API key. A phone
-- behind a counter is lost, borrowed and stolen; an API key on it could not be
-- revoked without taking the merchant's whole shop down with it.
CREATE TABLE IF NOT EXISTS pos_devices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    label         text NOT NULL,

    -- Enrolment: the merchant creates the device in the console and gets a
    -- short-lived code as a QR. The phone claims it once and receives the
    -- long-lived token. Only hashes are stored, as everywhere else.
    enrol_code_hash  text UNIQUE,
    enrol_expires_at timestamptz,
    token_hash       text UNIQUE,
    claimed_at       timestamptz,

    expires_at    timestamptz,            -- optional automatic death
    revoked_at    timestamptz,            -- revocation is the control, not a PIN
    -- No IP and no user agent: a privacy product does not log the till.
    last_seen_at  timestamptz,

    default_currency text CHECK (default_currency ~ '^[A-Z]{3}$'),
    -- The 0-conf acceptance policy, in money, because that is how a cashier
    -- thinks about risk. Zero means confirmations for everything.
    zeroconf_limit    numeric(14,2) NOT NULL DEFAULT 0 CHECK (zeroconf_limit >= 0),
    zeroconf_currency text NOT NULL DEFAULT 'USD' CHECK (zeroconf_currency ~ '^[A-Z]{3}$'),
    tip_presets   jsonb NOT NULL DEFAULT '[]',
    charge_expiry_min integer NOT NULL DEFAULT 15 CHECK (charge_expiry_min BETWEEN 5 AND 1440),

    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, label)
);
CREATE INDEX IF NOT EXISTS pos_devices_merchant_idx ON pos_devices (merchant_id);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pos_device_id uuid REFERENCES pos_devices(id);
-- The 0-conf decision, frozen at mint time. A live policy consulted at display
-- time could flip mid-payment, and an XMR-denominated threshold would
-- silently re-price itself as the market moved.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accept_zeroconf boolean NOT NULL DEFAULT false;
-- An operator said the sale is complete: short payment waived, or topped up in
-- cash. Orthogonal to status, which is a statement about the chain and is
-- never written by a till.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS accepted_by_device uuid REFERENCES pos_devices(id);
-- "Charge the difference": a second invoice for the shortfall, rather than
-- rewriting a quote whose QR is already in the customer's wallet.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS remainder_of uuid REFERENCES invoices(id);

CREATE INDEX IF NOT EXISTS invoices_pos_idx ON invoices (pos_device_id, created_at DESC)
    WHERE pos_device_id IS NOT NULL;
