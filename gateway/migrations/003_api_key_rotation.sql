-- API key rotation with an overlap window.
--
-- The key is pasted into WooCommerce, into a .env, into whatever else the
-- merchant runs. A rotation that killed the old key instantly would take their
-- shop down the moment they pressed the button, so the old hash stays valid
-- for a grace period and the console reports whether anything is still using
-- it. Only hashes are stored, here as everywhere: a lost key is rotated, never
-- recovered.

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS api_key_created_at timestamptz;
UPDATE merchants SET api_key_created_at = created_at WHERE api_key_created_at IS NULL;

ALTER TABLE merchants ADD COLUMN IF NOT EXISTS prev_api_key_hash         text;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS prev_api_key_expires_at   timestamptz;
-- What makes the feature safe to use: the settings page can say "the old key
-- was used 40 seconds ago, something is still holding it" and later "not used
-- for two hours, safe to revoke".
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS prev_api_key_last_used_at timestamptz;

-- Partial, and deliberately not UNIQUE: 32 random bytes do not collide, and a
-- unique index could only ever fail a rotation for an impossible reason.
CREATE INDEX IF NOT EXISTS merchants_prev_api_key_idx ON merchants (prev_api_key_hash)
    WHERE prev_api_key_hash IS NOT NULL;
