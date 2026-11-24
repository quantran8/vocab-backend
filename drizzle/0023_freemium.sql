CREATE TABLE user_entitlements (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    source VARCHAR(16) NOT NULL CHECK (source IN ('appstore','redeem')),
    product_id TEXT,
    original_transaction_id TEXT,
    environment VARCHAR(16),
    status VARCHAR(16) NOT NULL CHECK (status IN ('active','grace','expired','revoked')),
    expires_at TIMESTAMPTZ NOT NULL,
    auto_renew BOOLEAN,
    signed_at TIMESTAMPTZ,
    redeem_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT user_entitlements_original_transaction_id_key UNIQUE (original_transaction_id),
    CHECK ((source = 'appstore') = (original_transaction_id IS NOT NULL))
);
CREATE INDEX idx_user_entitlements_user ON user_entitlements (user_id, expires_at);
CREATE TABLE appstore_notifications (
    notification_uuid UUID PRIMARY KEY,
    notification_type VARCHAR(64) NOT NULL,
    subtype VARCHAR(64),
    environment VARCHAR(16),
    original_transaction_id TEXT,
    signed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE redeem_codes (
    code TEXT PRIMARY KEY CHECK (code = upper(code) AND code ~ '^[A-Z0-9-]{4,64}$'),
    duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
    max_uses INTEGER NOT NULL CHECK (max_uses >= 1),
    used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
    expires_at TIMESTAMPTZ,
    disabled_at TIMESTAMPTZ,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE redeem_code_uses (
    code TEXT NOT NULL REFERENCES redeem_codes(code),
    user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    redeemed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (code, user_id)
);

-- Clients never reach these tables directly; the API runs as the owner.
ALTER TABLE user_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE appstore_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE redeem_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE redeem_code_uses ENABLE ROW LEVEL SECURITY;
