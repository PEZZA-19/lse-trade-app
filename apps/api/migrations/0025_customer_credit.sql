-- Customer credit (Joe, 18 Nov 2026): a job that comes to less than £0 (e.g. rent payments taken off
-- the work) is issued as a customer credit note, numbered from the credit note sequence (CN-0001…),
-- and used up against that customer's next invoices. It is not a refund: no money moves.
-- In the books it is a negative item in Accounts receivable; using it on an invoice moves nothing in
-- the books, it only changes what is still owed on each.

ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'approved', 'sent', 'part_paid', 'paid', 'credit'));

-- How much of a customer credit has been used on later invoices.
ALTER TABLE invoices ADD COLUMN credit_used_pence bigint NOT NULL DEFAULT 0 CHECK (credit_used_pence >= 0);
ALTER TABLE invoices ADD CONSTRAINT invoices_credit_shape CHECK (
  (status = 'credit' AND total_pence < 0 AND paid_pence = 0 AND credited_pence = 0
     AND credit_used_pence <= -total_pence)
  OR (status <> 'credit' AND credit_used_pence = 0)
);

CREATE TABLE credit_uses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  credit_invoice_id  uuid NOT NULL,
  invoice_id         uuid NOT NULL,
  amount_pence       bigint NOT NULL CHECK (amount_pence > 0),
  applied_on         date NOT NULL,
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (credit_invoice_id <> invoice_id),
  FOREIGN KEY (tenant_id, credit_invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);
CREATE INDEX credit_uses_credit_idx ON credit_uses (tenant_id, credit_invoice_id);
CREATE INDEX credit_uses_invoice_idx ON credit_uses (tenant_id, invoice_id);

ALTER TABLE credit_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_uses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_uses
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- Uses are never edited or deleted (like payments): the record of where a credit went stays.
GRANT SELECT, INSERT ON credit_uses TO app_user;
