-- Each person's own charge-out rate (what the customer pays per hour of their time). No row means
-- the business labour rate (default £45/h), so existing jobs, invoices and reports are unchanged.
CREATE TABLE member_charge_out (
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users (id),
  charge_out_pence  bigint NOT NULL CHECK (charge_out_pence BETWEEN 0 AND 100000),
  updated_by        uuid REFERENCES users (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE member_charge_out ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_charge_out FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_charge_out
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON member_charge_out TO app_user;
