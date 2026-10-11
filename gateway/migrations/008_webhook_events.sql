-- More webhook events, opt in.
--
-- Every existing row holds one of the two original values, so widening the
-- constraint cannot fail on existing data. Dropped by name with IF EXISTS
-- because a database built by `migrate --baseline` may not carry Postgres's
-- auto-generated name for it.
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_event_check;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_check
  CHECK (event IN ('payment_detected', 'payment_confirmed', 'invoice_expired',
                   'payment_underpaid', 'payment_overpaid', 'page_goal_reached',
                   'pos_charge_accepted'));

-- New events must not surprise an integration written against the original
-- two, so they are off until a merchant asks for them. Filtered at enqueue
-- rather than at delivery, so a disabled event does not pile up undelivered
-- rows that look like a backlog.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_events text[] NOT NULL
  DEFAULT ARRAY['payment_detected', 'payment_confirmed'];
