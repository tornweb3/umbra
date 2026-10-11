-- Pre-minted subaddresses.
--
-- Minting one is not expensive because create_address is slow; it is expensive
-- because every withWallet() call takes the global advisory lock and pays a
-- full open_wallet / work / close_wallet / store cycle. A public donation page
-- that minted per visitor would therefore be a denial of service against the
-- merchant's own chain scanner, which needs that same lock.
--
-- So the worker mints in batches (one lock acquisition, N create_address
-- calls, one store) and the request path only ever claims a row that is
-- already there.
CREATE TABLE IF NOT EXISTS subaddress_pool (
    merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    subaddr_index integer NOT NULL,
    subaddress    text NOT NULL,
    claimed_at    timestamptz,            -- NULL means available
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id, subaddr_index)
);

-- The claim is "oldest unclaimed row for this merchant", so the partial index
-- is exactly the working set and shrinks as the pool is used.
CREATE INDEX IF NOT EXISTS subaddress_pool_free_idx
    ON subaddress_pool (merchant_id, subaddr_index) WHERE claimed_at IS NULL;

-- 0 keeps today's behaviour: no pool, mint inline. Raised automatically when a
-- merchant first creates something that mints for anonymous visitors.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS pool_target integer NOT NULL DEFAULT 0;
