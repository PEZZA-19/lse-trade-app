-- Price list (with history), quote kits, invoices and payments.

/* ------------------------------ price list ------------------------------ */

CREATE TABLE price_list_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  code              text CHECK (char_length(code) BETWEEN 1 AND 60),
  description       text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  unit              text NOT NULL DEFAULT 'each' CHECK (char_length(unit) BETWEEN 1 AND 20),
  supplier          text CHECK (char_length(supplier) <= 100),
  unit_cost_pence   bigint NOT NULL CHECK (unit_cost_pence >= 0),
  -- null = the business default markup
  markup_bp         int CHECK (markup_bp IS NULL OR markup_bp BETWEEN 10000 AND 100000),
  -- explicit sell price; wins over cost x markup
  sell_price_pence  bigint CHECK (sell_price_pence IS NULL OR sell_price_pence >= 0),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX price_list_items_code_key ON price_list_items (tenant_id, lower(code)) WHERE code IS NOT NULL;
CREATE INDEX price_list_items_desc_idx ON price_list_items (tenant_id, lower(description));

CREATE TABLE price_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  item_id           uuid NOT NULL,
  old_cost_pence    bigint,
  new_cost_pence    bigint NOT NULL,
  source            text NOT NULL CHECK (source IN ('created', 'manual', 'csv', 'supplier_bill')),
  reference         text CHECK (char_length(reference) <= 200),
  user_id           uuid REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, item_id) REFERENCES price_list_items (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX price_history_item_idx ON price_history (tenant_id, item_id, created_at DESC);

/* --------------------------------- kits --------------------------------- */

CREATE TABLE kits (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description  text CHECK (char_length(description) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX kits_name_key ON kits (tenant_id, lower(name));

CREATE TABLE kit_lines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  kit_id     uuid NOT NULL,
  item_id    uuid NOT NULL,
  position   int NOT NULL CHECK (position >= 0),
  qty_milli  bigint NOT NULL CHECK (qty_milli > 0),
  UNIQUE (kit_id, position),
  FOREIGN KEY (tenant_id, kit_id) REFERENCES kits (tenant_id, id) ON DELETE CASCADE,
  -- An item used in a kit can't be deleted (deactivate it instead).
  FOREIGN KEY (tenant_id, item_id) REFERENCES price_list_items (tenant_id, id)
);
CREATE INDEX kit_lines_item_idx ON kit_lines (tenant_id, item_id);

-- When an item price changes, each kit using it records its old and new cost and sell.
CREATE TABLE kit_cost_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  kit_id           uuid NOT NULL,
  item_id          uuid,
  item_description text NOT NULL,
  old_cost_pence   bigint NOT NULL,
  new_cost_pence   bigint NOT NULL,
  old_sell_pence   bigint NOT NULL,
  new_sell_pence   bigint NOT NULL,
  source           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, kit_id) REFERENCES kits (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX kit_cost_changes_kit_idx ON kit_cost_changes (tenant_id, kit_id, created_at DESC);

-- A kit on a quote is one costed block; its components are frozen with the line.
ALTER TABLE quote_lines ADD COLUMN kit jsonb;

/* ------------------------------- invoices ------------------------------- */

-- Invoice numbers follow the job: 122, then 122-2, 122-3. Given out on approval, so never a gap.
ALTER TABLE jobs ADD COLUMN invoice_count int NOT NULL DEFAULT 0;

CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  job_id              uuid NOT NULL,
  number              text,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'approved', 'sent', 'part_paid', 'paid')),
  source              text NOT NULL CHECK (source IN ('job', 'quote')),
  quote_mode          text CHECK (quote_mode IN ('whole', 'deposit', 'percent', 'remainder')),
  quote_id            uuid,
  -- The part of the quote this invoice covers (quote invoices only), for "remainder".
  quote_amount_pence  bigint,
  issue_date          date,
  due_date            date,
  terms_days          int NOT NULL CHECK (terms_days BETWEEN 0 AND 365),
  notes               text CHECK (char_length(notes) <= 4000),
  subtotal_pence      bigint NOT NULL DEFAULT 0,
  tax_pence           bigint NOT NULL DEFAULT 0,
  total_pence         bigint NOT NULL DEFAULT 0,
  paid_pence          bigint NOT NULL DEFAULT 0 CHECK (paid_pence >= 0),
  approved_by         uuid REFERENCES users (id),
  approved_at         timestamptz,
  sent_by             uuid REFERENCES users (id),
  sent_at             timestamptz,
  version             int NOT NULL DEFAULT 1,
  created_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK (status IN ('draft') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  CHECK (status NOT IN ('sent', 'part_paid', 'paid') OR sent_at IS NOT NULL),
  CHECK (paid_pence <= total_pence OR total_pence < 0)
);
CREATE UNIQUE INDEX invoices_number_key ON invoices (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX invoices_job_idx ON invoices (tenant_id, job_id);
CREATE INDEX invoices_status_idx ON invoices (tenant_id, status, due_date);

CREATE TABLE invoice_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  invoice_id        uuid NOT NULL,
  position          int NOT NULL CHECK (position >= 0),
  kind              text NOT NULL CHECK (kind IN ('labour', 'material', 'carriage', 'pc_sum', 'deposit', 'adjustment')),
  description       text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  qty_milli         bigint NOT NULL,
  unit_price_pence  bigint NOT NULL,
  total_pence       bigint NOT NULL,
  tax_rate_bp       int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  UNIQUE (invoice_id, position),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE CASCADE
);

-- Work that has been put on an invoice (reserved by a draft; freed if the draft is deleted).
ALTER TABLE timesheets ADD COLUMN invoice_id uuid;
ALTER TABLE timesheets ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE SET NULL (invoice_id);
ALTER TABLE job_lines ADD COLUMN invoice_id uuid;
ALTER TABLE job_lines ADD FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE SET NULL (invoice_id);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  amount_pence  bigint NOT NULL CHECK (amount_pence > 0),
  paid_on       date NOT NULL,
  method        text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'card', 'cheque', 'other')),
  reference     text CHECK (char_length(reference) <= 200),
  recorded_by   uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
CREATE INDEX payments_invoice_idx ON payments (tenant_id, invoice_id);

-- updated_at / version maintenance (helpers from earlier migrations).
CREATE TRIGGER price_list_items_updated BEFORE UPDATE ON price_list_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kits_updated BEFORE UPDATE ON kits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoices_version BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION bump_version();

/* ---------------------------------- RLS ---------------------------------- */

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_list_items', 'price_history', 'kits', 'kit_lines', 'kit_cost_changes',
                           'invoices', 'invoice_lines', 'payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON price_list_items, kits, kit_lines, invoices, invoice_lines TO app_user;
-- Histories and payments are append-only for the app (a payment is corrected with a new entry, later).
GRANT SELECT, INSERT ON price_history, kit_cost_changes, payments TO app_user;
