-- Job detail: notes, photos (files live in object storage; this is the index), hand-entered
-- timesheets (table exists), and what each person costs per hour for job profit.

CREATE TABLE job_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  job_id      uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users (id),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX job_notes_job_idx ON job_notes (tenant_id, job_id, created_at);

CREATE TABLE job_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  job_id        uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users (id),
  storage_key   text NOT NULL UNIQUE CHECK (char_length(storage_key) <= 200),
  content_type  text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes         int NOT NULL CHECK (bytes BETWEEN 1 AND 3000000),
  width         int CHECK (width > 0),
  height        int CHECK (height > 0),
  caption       text CHECK (char_length(caption) <= 300),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX job_photos_job_idx ON job_photos (tenant_id, job_id, created_at);

-- What each person really costs per hour: a base cost (wages) plus tax/on-costs (social
-- insurance, holiday, pension...). Total = base + on-cost. Missing = use the labour rate.
CREATE TABLE member_costs (
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id),
  base_cost_pence  bigint NOT NULL CHECK (base_cost_pence BETWEEN 0 AND 100000),
  on_cost_pence    bigint NOT NULL DEFAULT 0 CHECK (on_cost_pence BETWEEN 0 AND 100000),
  -- Seeded/demo values the owner has not confirmed yet; shown as "Placeholder".
  is_placeholder   boolean NOT NULL DEFAULT false,
  updated_by       uuid REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

-- Reporting year: from year_effective_from onward, "This Year" starts on year_start (MM-DD).
-- Before that date the original rule applies (calendar year to date), so past reports never move.
ALTER TABLE tenants ADD COLUMN year_start text NOT NULL DEFAULT '01-01'
  CHECK (year_start ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');
ALTER TABLE tenants ADD COLUMN year_effective_from date NOT NULL DEFAULT '2027-01-01';

-- A note on hand-entered time ("forgot to start the timer").
ALTER TABLE timesheets ADD COLUMN updated_by uuid REFERENCES users (id);
ALTER TABLE timesheets ADD COLUMN updated_at timestamptz;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_notes', 'job_photos', 'member_costs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;
