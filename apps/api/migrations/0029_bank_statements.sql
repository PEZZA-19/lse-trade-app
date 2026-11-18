-- Bank statement import and matching (session 6). The owner downloads a CSV from their bank and
-- imports it; each line becomes a bank transaction. Matching ties a line to what the app already
-- knows (a customer payment, a supplier bill payment, an expense), so the app's Bank and Cash can be
-- checked against the real bank. Importing never changes the books by itself.

CREATE TABLE bank_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  file_name     text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  rows_added    integer NOT NULL CHECK (rows_added >= 0),
  rows_existing integer NOT NULL CHECK (rows_existing >= 0),
  from_date     date,
  to_date       date,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bank_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_imports
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON bank_imports TO app_user;

CREATE TABLE bank_transactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  import_id      uuid NOT NULL,
  posted_on      date NOT NULL,
  description    text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  reference      text NOT NULL DEFAULT '' CHECK (char_length(reference) <= 200),
  amount_pence   bigint NOT NULL CHECK (amount_pence <> 0 AND abs(amount_pence) <= 100000000000),
  balance_pence  bigint,
  -- Same date, amount, description and reference, and which repeat of those it is in its file.
  fingerprint    text NOT NULL,
  status         text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'ignored')),
  match_kind     text CHECK (match_kind IN ('payment', 'bill_payment', 'expense')),
  match_id       uuid,
  matched_by     uuid REFERENCES users (id),
  matched_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fingerprint),
  FOREIGN KEY (import_id) REFERENCES bank_imports (id),
  CHECK ((status = 'matched') = (match_kind IS NOT NULL AND match_id IS NOT NULL))
);
CREATE INDEX bank_transactions_date_idx ON bank_transactions (tenant_id, posted_on DESC);
CREATE INDEX bank_transactions_status_idx ON bank_transactions (tenant_id, status);
-- One bank line per payment, bill payment or expense.
CREATE UNIQUE INDEX bank_transactions_match_once ON bank_transactions (tenant_id, match_kind, match_id)
  WHERE match_kind IS NOT NULL;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_transactions
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON bank_transactions TO app_user;
