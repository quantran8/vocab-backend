-- Supabase exposes the public schema through PostgREST; RLS without policies denies anon/authenticated.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

CREATE FUNCTION forbid_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER meaning_publications_immutable
  BEFORE UPDATE ON meaning_publications
  FOR EACH ROW EXECUTE FUNCTION forbid_immutable_update();

CREATE TRIGGER session_tasks_immutable
  BEFORE UPDATE OF client_payload, server_evaluation ON session_tasks
  FOR EACH ROW EXECUTE FUNCTION forbid_immutable_update();

CREATE TRIGGER practice_items_published_immutable
  BEFORE UPDATE OF template, variant, context_cefr_level, source_content, source_evaluation ON practice_items
  FOR EACH ROW WHEN (OLD.status IN ('published', 'retired'))
  EXECUTE FUNCTION forbid_immutable_update();
