-- Customer credit on jobs not yet invoiced (Joe, 18 Nov 2026, 10:27): "You can apply the credit if
-- the job hasn't been invoiced but if it has don't worry about it." The owner can choose on the
-- quote or the job to use the customer's credit; the choice carries from the quote to its job and
-- sets the default on the invoice's Approve sheet, which still asks to confirm.
-- NULL = not chosen yet, true = use it, false = keep it for later.
ALTER TABLE quotes ADD COLUMN use_credit boolean;
ALTER TABLE jobs ADD COLUMN use_credit boolean;
