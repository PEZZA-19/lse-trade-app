-- Labour on quote kits: fitting time per kit and per item (minutes), priced at the charge-out
-- rate when the kit goes on a quote.
ALTER TABLE kits ADD COLUMN labour_minutes integer NOT NULL DEFAULT 0
  CHECK (labour_minutes BETWEEN 0 AND 100000);
ALTER TABLE kit_lines ADD COLUMN labour_minutes integer NOT NULL DEFAULT 0
  CHECK (labour_minutes BETWEEN 0 AND 100000);
