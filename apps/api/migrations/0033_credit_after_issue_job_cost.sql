-- Joe, 18 Nov 2026 11:34: credit used on an already-invoiced job lowers that job's costs; the
-- customer still owes the invoice as billed. Undo the earlier treatment (it reduced what was owed).
WITH used AS (
  SELECT invoice_id, SUM(amount_pence) AS pence
    FROM credit_uses WHERE after_issue GROUP BY invoice_id
)
UPDATE invoices v
   SET credited_pence = v.credited_pence - used.pence,
       status = CASE
         WHEN v.status = 'paid' AND v.paid_pence + v.credited_pence - used.pence < v.total_pence
           THEN CASE WHEN v.paid_pence > 0 THEN 'part_paid' ELSE 'sent' END
         ELSE v.status END
  FROM used
 WHERE v.id = used.invoice_id;
