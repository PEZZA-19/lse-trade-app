-- Two-way calendar sync is Google Calendar only for now (Joe, 18 Nov 2026), signed in with OAuth
-- (authorization code + PKCE). The refresh token is sealed by the Worker (AES-GCM, key in a Worker
-- secret) before it reaches the database.

DELETE FROM calendar_connections WHERE provider <> 'google';
ALTER TABLE calendar_connections DROP CONSTRAINT calendar_connections_provider_check;
ALTER TABLE calendar_connections ADD CONSTRAINT calendar_connections_provider_check
  CHECK (provider IN ('google'));
-- Why the last sync failed (e.g. access removed in the Google account), shown in plain English.
ALTER TABLE calendar_connections ADD COLUMN last_error text CHECK (char_length(last_error) <= 500);

-- One sign-in in progress per person: the random state (stored hashed) ties Google's redirect back
-- to the person who started it; the PKCE verifier proves the code is ours. Ten minutes to finish.
CREATE TABLE calendar_oauth_states (
  state_hash     text PRIMARY KEY CHECK (char_length(state_hash) = 64),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('google')),
  code_verifier  text NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  expires_at     timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX calendar_oauth_states_user_idx ON calendar_oauth_states (tenant_id, user_id);
ALTER TABLE calendar_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON calendar_oauth_states
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, DELETE ON calendar_oauth_states TO app_user;

-- The scheduled sync (Workers cron) needs to know whose calendars are due, across businesses.
-- One narrow door, like held_due_tenants(): only (business, person) pairs, nothing else.
CREATE OR REPLACE FUNCTION calendar_sync_due(p_every interval)
RETURNS TABLE (tenant_id uuid, user_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT c.tenant_id, c.user_id, m.role
    FROM calendar_connections c
    JOIN memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.user_id
   WHERE c.status = 'connected'
     AND (c.last_synced_at IS NULL OR c.last_synced_at <= now() - p_every)
$$;
REVOKE ALL ON FUNCTION calendar_sync_due(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_sync_due(interval) TO app_user;
-- Same reason as 0021: FORCE RLS binds the owner too on Neon; read-only for the definer function.
CREATE POLICY owner_access ON calendar_connections FOR SELECT
  USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.calendar_connections'::regclass));
