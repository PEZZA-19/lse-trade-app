-- 0005_job_stages: Tradify-style job stages (8 system stages + custom ones per business), a job history
-- of every stage change, and the minimal assignment / appointment / timer tables that drive the
-- automatic transitions. Invoices don't exist yet: the "fully invoiced and paid" hook is a service call.

CREATE TABLE job_stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- System stages have a fixed key the automation relies on; custom stages have none.
  system_key  text CHECK (system_key IN ('unassigned', 'assigned', 'scheduled', 'in_progress',
                                         'to_invoice', 'complete', 'on_hold', 'cancelled')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  colour      text NOT NULL CHECK (colour IN ('grey', 'blue', 'indigo', 'purple', 'teal', 'green',
                                              'yellow', 'orange', 'red', 'pink')),
  -- Jobs in an active stage show on the Active list (Complete and Cancelled are not active).
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, system_key)
);
CREATE UNIQUE INDEX job_stages_name_key ON job_stages (tenant_id, lower(name));
CREATE TRIGGER job_stages_updated_at BEFORE UPDATE ON job_stages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The 8 system stages for one business. SECURITY INVOKER: run inside a transaction scoped to that tenant
-- (or by the schema owner when creating a business).
CREATE OR REPLACE FUNCTION create_system_stages(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO job_stages (tenant_id, system_key, name, colour, is_active, sort_order) VALUES
    (p_tenant, 'unassigned',  'Unassigned',  'grey',   true,  10),
    (p_tenant, 'assigned',    'Assigned',    'indigo', true,  20),
    (p_tenant, 'scheduled',   'Booked in',   'blue',   true,  30),
    (p_tenant, 'in_progress', 'In Progress', 'orange', true,  40),
    (p_tenant, 'to_invoice',  'To Invoice',  'purple', true,  50),
    (p_tenant, 'complete',    'Complete',    'green',  false, 60),
    (p_tenant, 'on_hold',     'On Hold',     'yellow', true,  70),
    (p_tenant, 'cancelled',   'Cancelled',   'red',    false, 80)
  ON CONFLICT (tenant_id, system_key) DO NOTHING;
$$;

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP PERFORM create_system_stages(t); END LOOP;
END $$;

/* -------------------------- jobs: status -> stage ------------------------- */

ALTER TABLE jobs ADD COLUMN stage_id uuid;
UPDATE jobs j SET stage_id = s.id
  FROM job_stages s
 WHERE s.tenant_id = j.tenant_id
   AND s.system_key = CASE j.status
         WHEN 'open' THEN 'unassigned' WHEN 'scheduled' THEN 'scheduled' WHEN 'in_progress' THEN 'in_progress'
         WHEN 'completed' THEN 'complete' WHEN 'cancelled' THEN 'cancelled' END;
ALTER TABLE jobs ALTER COLUMN stage_id SET NOT NULL;
ALTER TABLE jobs ADD FOREIGN KEY (tenant_id, stage_id) REFERENCES job_stages (tenant_id, id);
DROP INDEX jobs_tenant_status_idx;
ALTER TABLE jobs DROP COLUMN status;
CREATE INDEX jobs_tenant_stage_idx ON jobs (tenant_id, stage_id);

/* ------------------------------- job history ------------------------------ */

CREATE TABLE job_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  job_id         uuid NOT NULL,
  from_stage_id  uuid,
  to_stage_id    uuid,  -- NULL once a deleted custom / To Invoice / On Hold stage is gone
  -- Names as they were at the time, so renaming a stage later doesn't rewrite history.
  from_name      text,
  to_name        text NOT NULL,
  cause          text NOT NULL CHECK (cause IN ('created', 'created_from_quote', 'manual', 'assigned',
                                                 'appointment_created', 'appointment_deleted',
                                                 'timer_started', 'invoiced_and_paid')),
  user_id        uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE,
  -- Deleting a stage keeps history (names are snapshotted) and only clears the link.
  FOREIGN KEY (tenant_id, from_stage_id) REFERENCES job_stages (tenant_id, id) ON DELETE SET NULL (from_stage_id),
  FOREIGN KEY (tenant_id, to_stage_id) REFERENCES job_stages (tenant_id, id) ON DELETE SET NULL (to_stage_id)
);
CREATE INDEX job_history_job_idx ON job_history (tenant_id, job_id, created_at);

-- Existing jobs get a starting entry so every job has a history.
INSERT INTO job_history (tenant_id, job_id, to_stage_id, to_name, cause, user_id, created_at)
SELECT j.tenant_id, j.id, j.stage_id, s.name,
       CASE WHEN j.source_quote_id IS NULL THEN 'created' ELSE 'created_from_quote' END, j.created_by, j.created_at
  FROM jobs j JOIN job_stages s ON s.id = j.stage_id;

/* ------------- minimal assignment / appointment / timer tables ------------ */

CREATE TABLE job_assignees (
  tenant_id   uuid NOT NULL,
  job_id      uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE appointments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  job_id      uuid NOT NULL,
  user_id     uuid REFERENCES users (id),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL CHECK (ends_at > starts_at),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX appointments_job_idx ON appointments (tenant_id, job_id);

CREATE TABLE job_timers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  job_id      uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users (id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  stopped_at  timestamptz CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);
-- One running timer per person.
CREATE UNIQUE INDEX job_timers_running_key ON job_timers (tenant_id, user_id) WHERE stopped_at IS NULL;

/* ---------------------------------- RLS ---------------------------------- */

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['job_stages', 'job_history', 'job_assignees', 'appointments', 'job_timers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON job_stages, job_assignees, appointments, job_timers TO app_user;
-- History is append-only for the app.
GRANT SELECT, INSERT ON job_history TO app_user;
GRANT EXECUTE ON FUNCTION create_system_stages(uuid) TO app_user;
