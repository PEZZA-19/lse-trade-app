-- Who can see which areas, chosen by an admin. No row = the default for the person's role
-- (owners: admin; staff and accountants: Office = accounts, quotes, settings; subcontractors: none), which is
-- what everyone could see before this migration.
CREATE TABLE member_access (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id),
  is_admin    boolean NOT NULL DEFAULT false,
  areas       text[] NOT NULL DEFAULT '{}'
    CHECK (areas <@ ARRAY['financials', 'reports', 'costs', 'quotes', 'settings']::text[]),
  updated_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE member_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_access
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON member_access TO app_user;
