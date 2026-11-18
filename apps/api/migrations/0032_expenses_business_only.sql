-- Joe, 18 Nov 2026, 10:36: "Expenses just come from the profit of the company." There is no
-- "paid personally" any more: every expense is the business's, out of the business account.
-- Any recorded as paid personally become ordinary business expenses.
UPDATE expenses SET paid_from = 'bank' WHERE paid_from <> 'bank';
ALTER TABLE expenses DROP COLUMN paid_from;
