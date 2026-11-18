-- Expenses and wages (session 6): overheads that aren't supplier bills for materials (insurance,
-- fuel, phone, ferries, software...) and wages, so the Profit and Loss shows a real net profit.
-- Each is money already spent: from the business bank, or by the owner personally.

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  spent_on        date NOT NULL,
  payee           text NOT NULL CHECK (char_length(payee) BETWEEN 1 AND 200),
  account_code    text NOT NULL
                    CHECK (account_code IN ('404', '412', '429', '433', '449', '463', '473', '477', '489', '493')),
  description     text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  amount_pence    bigint NOT NULL CHECK (amount_pence > 0 AND amount_pence <= 10000000000),
  tax_pence       bigint NOT NULL DEFAULT 0 CHECK (tax_pence >= 0 AND tax_pence <= amount_pence),
  paid_from       text NOT NULL DEFAULT 'bank' CHECK (paid_from IN ('bank', 'owner')),
  -- Wages: who was paid (optional).
  member_user_id  uuid REFERENCES users (id),
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_date_idx ON expenses (tenant_id, spent_on DESC);
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expenses
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- Entered or removed (by the owner, with an audit entry); never edited in place.
GRANT SELECT, INSERT, DELETE ON expenses TO app_user;

-- Budgets can now be set for the overhead and wage accounts too.
ALTER TABLE budgets DROP CONSTRAINT IF EXISTS budgets_account_code_check;
ALTER TABLE budgets ADD CONSTRAINT budgets_account_code_check CHECK (account_code IN
  ('200', '210', '310', '404', '412', '429', '433', '449', '463', '473', '477', '489', '493'));
