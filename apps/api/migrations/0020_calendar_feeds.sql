-- 0020_calendar_feeds: one-way calendar subscription (iCal) per person. Each link is a long random
-- token; regenerating replaces it, so the old link stops working at once. Each person sees only
-- their own links. The feed request has no session, so one narrow definer function maps a token to
-- its business and person; everything else runs in that business's RLS scope.
CREATE TABLE calendar_feeds (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id),
  scope       text NOT NULL CHECK (scope IN ('mine', 'all')),
  token       text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{32,64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, scope)
);
ALTER TABLE calendar_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_feeds FORCE ROW LEVEL SECURITY;
CREATE POLICY own_feeds ON calendar_feeds
  USING (tenant_id = app_current_tenant() AND user_id = app_current_user())
  WITH CHECK (tenant_id = app_current_tenant() AND user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_feeds TO app_user;
-- FORCE RLS also binds the table owner (unless a superuser, as on Neon it is not): let the definer
-- function below, which runs as the owner, read it. app_user can never become the owner.
CREATE POLICY owner_access ON calendar_feeds FOR SELECT
  USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.calendar_feeds'::regclass));

-- Token -> business, person, scope and role (only while they are still a member).
CREATE OR REPLACE FUNCTION calendar_feed_owner(p_token text)
RETURNS TABLE (tenant_id uuid, user_id uuid, scope text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.tenant_id, f.user_id, f.scope, m.role
    FROM calendar_feeds f
    JOIN memberships m ON m.tenant_id = f.tenant_id AND m.user_id = f.user_id
   WHERE f.token = p_token
$$;
REVOKE ALL ON FUNCTION calendar_feed_owner(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_feed_owner(text) TO app_user;
