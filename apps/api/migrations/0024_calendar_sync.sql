-- Two-way calendar sync (Google Calendar, Microsoft 365). Each person can connect their own
-- calendar; the app writes job appointments to a dedicated "LSE jobs" calendar there and reads back
-- moves and deletes as proposals (never silent changes). Tokens are stored encrypted by the Worker
-- (the database never sees them in plain text).

CREATE TABLE calendar_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  account_email    text CHECK (char_length(account_email) <= 320),
  calendar_id      text NOT NULL CHECK (char_length(calendar_id) BETWEEN 1 AND 500),
  calendar_name    text NOT NULL DEFAULT 'LSE jobs' CHECK (char_length(calendar_name) BETWEEN 1 AND 200),
  token_enc        text NOT NULL,
  sync_token       text,
  status           text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_reconnect')),
  last_synced_at   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, provider)
);

CREATE TABLE calendar_event_links (
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  connection_id      uuid NOT NULL,
  appointment_id     uuid NOT NULL,
  remote_id          text NOT NULL CHECK (char_length(remote_id) BETWEEN 1 AND 1000),
  etag               text,
  app_hash           text NOT NULL,
  remote_starts_at   timestamptz NOT NULL,
  remote_ends_at     timestamptz NOT NULL,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, appointment_id),
  UNIQUE (connection_id, remote_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES calendar_connections (tenant_id, id) ON DELETE CASCADE
  -- No foreign key to appointments: when an appointment is deleted the link stays until the next
  -- sync deletes the calendar event too.
);

ALTER TABLE proposals DROP CONSTRAINT proposals_kind_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('reply_email', 'overdue_reminder', 'quote_draft', 'price_update', 'calendar_change'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendar_connections', 'calendar_event_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;
