-- Google Play subscriptions: a purchase token is stored as original_transaction_id.
ALTER TABLE user_entitlements DROP CONSTRAINT user_entitlements_source_check;
ALTER TABLE user_entitlements ADD CONSTRAINT user_entitlements_source_check CHECK (source IN ('appstore','playstore','redeem'));
ALTER TABLE user_entitlements DROP CONSTRAINT user_entitlements_check;
ALTER TABLE user_entitlements ADD CONSTRAINT user_entitlements_check CHECK ((source IN ('appstore','playstore')) = (original_transaction_id IS NOT NULL));

CREATE TABLE playstore_notifications (
    message_id TEXT PRIMARY KEY,
    notification_type INTEGER,
    purchase_token TEXT,
    event_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients never reach this table directly; the API runs as the owner.
ALTER TABLE playstore_notifications ENABLE ROW LEVEL SECURITY;
