-- The cron that releases held emails has no session, so RLS shows it nothing. This function is its
-- one narrow door: it returns only the ids of businesses with an email whose hold is over. The
-- release itself then runs per business inside the normal tenant-scoped transaction.
CREATE OR REPLACE FUNCTION held_due_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT p.tenant_id FROM proposals p WHERE p.status = 'held' AND p.hold_until <= now()
$$;
REVOKE ALL ON FUNCTION held_due_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION held_due_tenants() TO app_user;
