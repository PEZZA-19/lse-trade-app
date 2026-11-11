-- held_due_tenants() (0016) runs as the table owner, but proposals has FORCE ROW LEVEL SECURITY, which
-- binds the owner too unless it is a superuser (true locally, not on Neon). Without this the cron
-- would see no held emails once deployed. Read-only, and app_user can never become the owner.
CREATE POLICY owner_access ON proposals FOR SELECT
  USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.proposals'::regclass));
