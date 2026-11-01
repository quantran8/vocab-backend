-- Custom words join a shared pool, so a lemma must exist only once; fails on existing duplicates, which must be merged first.
CREATE UNIQUE INDEX words_language_lemma_key ON words(language, lower(btrim(lemma)), homograph_key) NULLS NOT DISTINCT;
ALTER TABLE word_types ADD UNIQUE (word_id, part_of_speech);
--> statement-breakpoint
ALTER TABLE topics ADD COLUMN owner_user_id UUID REFERENCES app_user(id);
CREATE UNIQUE INDEX topics_owner_user_id_key ON topics(owner_user_id) WHERE owner_user_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE meanings
  ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'curated' CHECK (origin IN ('curated','ai_generated')),
  ADD COLUMN created_by_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN owner_user_id UUID REFERENCES app_user(id),
  ADD COLUMN reviewed_by_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN lexical_draft_id UUID,
  ADD COLUMN draft_sense_index SMALLINT,
  ADD UNIQUE (lexical_draft_id, draft_sense_index);
CREATE INDEX idx_meanings_ai_generated ON meanings(created_at DESC) WHERE origin = 'ai_generated';
CREATE INDEX idx_meanings_owner ON meanings(owner_user_id) WHERE owner_user_id IS NOT NULL;
ALTER TABLE meaning_localizations
  ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'curated' CHECK (origin IN ('curated','ai_generated'));
--> statement-breakpoint
CREATE TABLE lexical_drafts (
  id UUID PRIMARY KEY,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('word','meaning','translation')),
  language VARCHAR(16) NOT NULL,
  normalized_text TEXT NOT NULL,
  locale VARCHAR(32) NOT NULL,
  context_key TEXT NOT NULL DEFAULT '',
  meaning_id UUID REFERENCES meanings(id),
  owner_user_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (language, normalized_text, locale, context_key)
);
CREATE INDEX idx_lexical_drafts_meaning ON lexical_drafts(meaning_id, locale) WHERE meaning_id IS NOT NULL;
ALTER TABLE meanings ADD FOREIGN KEY (lexical_draft_id) REFERENCES lexical_drafts(id);
--> statement-breakpoint
CREATE TABLE user_meaning_overrides (
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  meaning_id UUID NOT NULL REFERENCES meanings(id),
  locale VARCHAR(32) NOT NULL,
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, meaning_id, locale)
);
CREATE TABLE custom_word_usage (
  user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  lookups INTEGER NOT NULL DEFAULT 0 CHECK (lookups >= 0),
  PRIMARY KEY (user_id, day)
);
--> statement-breakpoint
ALTER TABLE lexical_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_meaning_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_word_usage ENABLE ROW LEVEL SECURITY;
