-- A deleted account's access tokens stay valid until they expire; without this they would provision a new empty user.
CREATE TABLE deleted_identities (
  identity_subject TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE deleted_identities ENABLE ROW LEVEL SECURITY;
