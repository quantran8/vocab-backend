ALTER TABLE collections ADD COLUMN color VARCHAR(7) CHECK (color ~ '^#[0-9A-F]{6}$');
ALTER TABLE topics ADD COLUMN ios_icon VARCHAR(100) CHECK (ios_icon ~ '^[a-z0-9]+(\.[a-z0-9]+)*$');
