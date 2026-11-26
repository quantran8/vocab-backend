ALTER TABLE topics ADD COLUMN color VARCHAR(7) CHECK (color ~ '^#[0-9A-F]{6}$');
