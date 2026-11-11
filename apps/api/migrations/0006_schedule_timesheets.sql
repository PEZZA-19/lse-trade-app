-- Scheduler, timer and timesheets on top of the stage stubs from 0005.

-- Appointments can be moved; keep when.
ALTER TABLE appointments ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX appointments_tenant_time_idx ON appointments (tenant_id, starts_at);

-- Timesheet entries. A stopped timer creates one (source 'timer'), linked to the job and the timer.
CREATE TABLE timesheets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  job_id      uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users (id),
  timer_id    uuid UNIQUE REFERENCES job_timers (id) ON DELETE SET NULL,
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz NOT NULL CHECK (ended_at >= started_at),
  source      text NOT NULL CHECK (source IN ('timer', 'manual')),
  note        text CHECK (char_length(note) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX timesheets_job_idx ON timesheets (tenant_id, job_id, started_at);
CREATE INDEX timesheets_user_idx ON timesheets (tenant_id, user_id, started_at);

ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON timesheets TO app_user;
