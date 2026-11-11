-- Customer credit notes. A credit note reduces what a customer owes on an issued invoice (a
-- mistake, a goodwill reduction, work not done). Drafted by anyone, approved by the owner; the
-- number (CN-0001…) is taken on approval inside the transaction, so the sequence never has gaps.
-- Approving takes the amount off the invoice balance; it never touches recorded payments.

CREATE TABLE credit_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  number        text,
  seq_value     bigint,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  issue_date    date,
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  amount_pence  bigint NOT NULL CHECK (amount_pence > 0),
  approved_by   uuid REFERENCES users (id),
  approved_at   timestamptz,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK (status = 'draft' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND issue_date IS NOT NULL))
);
CREATE UNIQUE INDEX credit_notes_number_key ON credit_notes (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX credit_notes_invoice_idx ON credit_notes (tenant_id, invoice_id);

ALTER TABLE invoices ADD COLUMN credited_pence bigint NOT NULL DEFAULT 0 CHECK (credited_pence >= 0);
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_check3;
ALTER TABLE invoices ADD CONSTRAINT invoices_settled_within_total
  CHECK (paid_pence + credited_pence <= total_pence OR total_pence < 0);

CREATE TRIGGER credit_notes_updated BEFORE UPDATE ON credit_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER credit_notes_version BEFORE UPDATE ON credit_notes FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_notes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_notes TO app_user;
