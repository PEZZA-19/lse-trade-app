-- 0004_versions: a row version for optimistic concurrency (offline edits sync later).
-- Every UPDATE bumps it; clients send the version they edited as If-Match and get 409 if it moved.
CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version := OLD.version + 1; RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'quotes', 'jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN version int NOT NULL DEFAULT 1', t);
    EXECUTE format('CREATE TRIGGER %I_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_version()', t, t);
  END LOOP;
END $$;
