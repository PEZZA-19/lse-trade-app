-- The business overview and Xero-style reports (Profit and Loss, Balance Sheet, aged balances,
-- cash flow, tax, budgets, account transactions) are worked out from the documents the app already
-- keeps. Three things were missing for honest books:
--  1. payments to suppliers (so a bill stops being owed and the bank goes down),
--  2. the bank balance on the day the app's records start (there is no bank feed yet),
--  3. monthly budgets per Profit and Loss account.

CREATE TABLE supplier_bill_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  bill_id       uuid NOT NULL,
  amount_pence  bigint NOT NULL CHECK (amount_pence > 0),
  paid_on       date NOT NULL,
  method        text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'card', 'cheque', 'other')),
  reference     text CHECK (char_length(reference) <= 200),
  recorded_by   uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES supplier_bills (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX supplier_bill_payments_bill_idx ON supplier_bill_payments (tenant_id, bill_id);

CREATE TABLE business_books (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  opening_date        date NOT NULL,
  opening_bank_pence  bigint NOT NULL CHECK (opening_bank_pence BETWEEN -10000000000 AND 10000000000),
  updated_by          uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budgets (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  month         date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  account_code  text NOT NULL CHECK (account_code IN ('200', '210', '310')),
  amount_pence  bigint NOT NULL CHECK (amount_pence BETWEEN 0 AND 10000000000),
  updated_by    uuid REFERENCES users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month, account_code)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_bill_payments', 'business_books', 'budgets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;
