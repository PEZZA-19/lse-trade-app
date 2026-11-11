-- Suppliers, supplier bills and supplier credit notes. A bill is entered (by hand, from a CSV, or
-- typed from a PDF), its lines matched to the price list, then applied by the owner after a
-- preview: new costs go through the price-update service (history + kit recalculation) and lines
-- allocated to a job become job material lines. Applied bills are read-only.

CREATE TABLE suppliers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  email        text CHECK (char_length(email) <= 254),
  phone        text CHECK (char_length(phone) <= 40),
  account_ref  text CHECK (char_length(account_ref) <= 60),
  notes        text CHECK (char_length(notes) <= 2000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (tenant_id, lower(name));

CREATE TABLE supplier_bills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  supplier_id  uuid NOT NULL,
  kind         text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill', 'credit_note')),
  reference    text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 100),
  bill_date    date NOT NULL,
  job_id       uuid,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'applied')),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv', 'pdf')),
  file_name    text CHECK (char_length(file_name) <= 200),
  notes        text CHECK (char_length(notes) <= 2000),
  total_pence  bigint NOT NULL DEFAULT 0,
  created_by   uuid NOT NULL REFERENCES users (id),
  applied_by   uuid REFERENCES users (id),
  applied_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE SET NULL (job_id)
);
-- The same supplier reference can't be entered twice (a duplicate bill would double the costs).
CREATE UNIQUE INDEX supplier_bills_ref_key ON supplier_bills (tenant_id, supplier_id, kind, lower(reference));
CREATE INDEX supplier_bills_date_idx ON supplier_bills (tenant_id, bill_date DESC);
CREATE INDEX supplier_bills_job_idx ON supplier_bills (tenant_id, job_id) WHERE job_id IS NOT NULL;

CREATE TABLE supplier_bill_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  bill_id          uuid NOT NULL,
  position         int NOT NULL CHECK (position >= 0),
  code             text CHECK (char_length(code) <= 60),
  description      text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  qty_milli        bigint NOT NULL CHECK (qty_milli > 0),
  unit_cost_pence  bigint NOT NULL CHECK (unit_cost_pence >= 0),
  total_pence      bigint NOT NULL,
  price_item_id    uuid,
  update_price     boolean NOT NULL DEFAULT true,
  allocation       text NOT NULL DEFAULT 'stock' CHECK (allocation IN ('job', 'stock', 'home')),
  job_line_id      uuid,
  UNIQUE (bill_id, position),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES supplier_bills (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, price_item_id) REFERENCES price_list_items (tenant_id, id) ON DELETE SET NULL (price_item_id)
);

-- Materials that came from a supplier bill are job costs, billable on a time-and-materials invoice.
ALTER TABLE job_lines DROP CONSTRAINT job_lines_source_check;
ALTER TABLE job_lines ADD CONSTRAINT job_lines_source_check CHECK (source IN ('quote', 'manual', 'supplier_bill'));
ALTER TABLE job_lines ADD COLUMN bill_line_id uuid REFERENCES supplier_bill_lines (id) ON DELETE SET NULL;

CREATE TRIGGER suppliers_updated BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER suppliers_version BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER supplier_bills_updated BEFORE UPDATE ON supplier_bills FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER supplier_bills_version BEFORE UPDATE ON supplier_bills FOR EACH ROW EXECUTE FUNCTION bump_version();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'supplier_bills', 'supplier_bill_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers, supplier_bills, supplier_bill_lines TO app_user;

-- Existing free-text suppliers on the price list become supplier records.
INSERT INTO suppliers (tenant_id, name)
SELECT DISTINCT ON (tenant_id, lower(supplier)) tenant_id, supplier
  FROM price_list_items WHERE supplier IS NOT NULL AND btrim(supplier) <> ''
ON CONFLICT DO NOTHING;
