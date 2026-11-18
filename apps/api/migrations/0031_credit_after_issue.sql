-- Customer credit on an invoice that's already been issued (Joe, 18 Nov 2026, 10:35): "it can be
-- applied to one which has been invoiced it obviously just won't adjust the billed amount but will
-- show on the p&l." The use is recorded (so the customer owes less and the credit is used up), but
-- the issued invoice and its PDF stay exactly as billed.
ALTER TABLE credit_uses ADD COLUMN after_issue boolean NOT NULL DEFAULT false;
