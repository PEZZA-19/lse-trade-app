-- Bills read from merchant PDFs carry a due date ("Date Payable", or worked out from printed
-- terms), and discounted lines keep the merchant's own rounded line total.
ALTER TABLE supplier_bills ADD COLUMN due_date date;
