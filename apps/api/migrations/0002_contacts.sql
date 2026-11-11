-- 0002_contacts: several named contacts per customer, optionally tied to a site, each with a role.
-- From docs/REQUIREMENTS_FROM_REVIEWS.md (M6): tenanted properties need tenant, landlord, agent,
-- managing agent, site contact and bill payer kept apart. Invoices go to the bill payer;
-- job messages can go to the site contact.

CREATE TABLE contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  customer_id  uuid NOT NULL,
  site_id      uuid,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  role         text NOT NULL DEFAULT 'other'
               CHECK (role IN ('bill_payer', 'site_contact', 'tenant', 'landlord', 'agent', 'managing_agent', 'other')),
  email        text CHECK (email IS NULL OR email = lower(email)),
  phone        text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX contacts_customer_idx ON contacts (tenant_id, customer_id);
CREATE INDEX contacts_site_idx ON contacts (tenant_id, site_id) WHERE site_id IS NOT NULL;

CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO app_user;

-- Rows created in one request (e.g. a customer with two sites) must keep their entry order.
-- now() is fixed per transaction, so use clock_timestamp() for creation order.
ALTER TABLE sites ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE customers ALTER COLUMN created_at SET DEFAULT clock_timestamp();
