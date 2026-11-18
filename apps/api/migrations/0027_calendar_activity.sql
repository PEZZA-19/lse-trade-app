-- Joe, 18 Nov 2026: a move or delete made in Google Calendar updates the app straight away (no
-- Approvals). Each change is logged here with what it replaced, so it can be undone from the
-- Calendar screen.

CREATE TABLE calendar_activity (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Whose calendar it came from (each person sees their own).
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('google')),
  appointment_id  uuid NOT NULL,
  job_id          uuid,
  kind            text NOT NULL CHECK (kind IN ('moved', 'deleted')),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  detail          text NOT NULL CHECK (char_length(detail) <= 1000),
  -- The appointment as it was before (job, person, times, linked enquiries), for Undo.
  before          jsonb NOT NULL,
  -- Times after a move (null for a delete).
  after           jsonb,
  -- The app had also changed it since the last sync (Google's change still won).
  conflict        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  undone_at       timestamptz,
  undone_by       uuid REFERENCES users (id)
);
CREATE INDEX calendar_activity_user_idx ON calendar_activity (tenant_id, user_id, created_at DESC);
CREATE INDEX calendar_activity_appt_idx ON calendar_activity (tenant_id, appointment_id, created_at DESC);
ALTER TABLE calendar_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON calendar_activity
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON calendar_activity TO app_user;

-- Deleting an appointment that an enquiry was booked into used to fail (no ON DELETE). The
-- enquiry keeps its history; it just stops pointing at the removed appointment.
ALTER TABLE enquiries DROP CONSTRAINT IF EXISTS enquiries_appointment_id_fkey;
ALTER TABLE enquiries ADD CONSTRAINT enquiries_appointment_id_fkey
  FOREIGN KEY (appointment_id) REFERENCES appointments (id) ON DELETE SET NULL;
