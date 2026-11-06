ALTER TABLE meanings ADD COLUMN popularity SMALLINT;
ALTER TABLE meanings ADD CONSTRAINT meanings_popularity_check CHECK (popularity BETWEEN 0 AND 100);
