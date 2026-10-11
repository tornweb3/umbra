-- One row, written by the worker at the end of every pass.
--
-- Without it there is no way to answer the question that matters most when
-- something looks stuck: is the worker running at all? A deployment with the
-- API up and no worker never provisions a wallet, never scans for payments and
-- never delivers a webhook, and until now it looked identical to a quiet one.
CREATE TABLE IF NOT EXISTS worker_heartbeat (
    -- A boolean primary key constrained to true: exactly one row, ever.
    id           boolean PRIMARY KEY DEFAULT true CHECK (id),
    last_pass_at timestamptz NOT NULL DEFAULT now(),
    pass_ms      integer,
    last_error   text
);
