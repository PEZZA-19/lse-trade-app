-- Assignment is separate from area access. Derive it from live membership/access rows so calendar
-- feeds, background sync and every service transaction follow the same policy. Missing membership
-- fails closed. Invoker functions only: no new owner/RLS bypass.
CREATE FUNCTION app_assignment_scoped() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT m.role = 'subcontractor' AND NOT coalesce(a.is_admin, false)
      FROM memberships m LEFT JOIN member_access a
        ON a.tenant_id = m.tenant_id AND a.user_id = m.user_id
     WHERE m.tenant_id = app_current_tenant() AND m.user_id = app_current_user()
  ), true)
$$;
CREATE FUNCTION app_job_assigned(p_job uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM job_assignees
    WHERE tenant_id = app_current_tenant() AND job_id = p_job AND user_id = app_current_user())
$$;
REVOKE ALL ON FUNCTION app_assignment_scoped(), app_job_assigned(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assignment_scoped(), app_job_assigned(uuid) TO app_user;
CREATE INDEX job_assignees_person_idx ON job_assignees (tenant_id, user_id, job_id);

-- Target the API role: preserve the existing narrow schema-owner cron read policies (0021).
CREATE POLICY assigned_job ON jobs AS RESTRICTIVE TO app_user
  USING (NOT app_assignment_scoped() OR app_job_assigned(id))
  WITH CHECK (NOT app_assignment_scoped() OR app_job_assigned(id));

-- Keep assignment SELECT tenant-scoped: jobs consult this table, so a parent predicate here would
-- recurse. The only API reader is already gated by the job parent. Scoped users cannot grant access.
CREATE POLICY assignment_insert ON job_assignees AS RESTRICTIVE FOR INSERT TO app_user
  WITH CHECK (NOT app_assignment_scoped());
CREATE POLICY assignment_update ON job_assignees AS RESTRICTIVE FOR UPDATE TO app_user
  USING (NOT app_assignment_scoped()) WITH CHECK (NOT app_assignment_scoped());
CREATE POLICY assignment_delete ON job_assignees AS RESTRICTIVE FOR DELETE TO app_user
  USING (NOT app_assignment_scoped());

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['job_lines','job_history','appointments','job_timers','timesheets',
                           'job_notes','job_photos','invoices','supplier_bills','calendar_activity'] LOOP
    EXECUTE format('CREATE POLICY assigned_parent ON %I AS RESTRICTIVE TO app_user
      USING (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id))
      WITH CHECK (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['invoice_lines','payments','credit_notes'] LOOP
    EXECUTE format('CREATE POLICY assigned_invoice ON %I AS RESTRICTIVE TO app_user
      USING (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id))
      WITH CHECK (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['supplier_bill_lines','supplier_bill_payments'] LOOP
    EXECUTE format('CREATE POLICY assigned_bill ON %I AS RESTRICTIVE TO app_user
      USING (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM supplier_bills b WHERE b.id = bill_id))
      WITH CHECK (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM supplier_bills b WHERE b.id = bill_id))', t);
  END LOOP;
  -- These carry unstructured snapshots / indirect identifiers which cannot safely be job-filtered.
  FOREACH t IN ARRAY ARRAY['enquiries','proposals','proposal_events','ai_calls','bank_imports','bank_transactions'] LOOP
    EXECUTE format('CREATE POLICY unscoped_only ON %I AS RESTRICTIVE TO app_user
      USING (NOT app_assignment_scoped()) WITH CHECK (NOT app_assignment_scoped())', t);
  END LOOP;
END $$;

CREATE POLICY assigned_quote ON quotes AS RESTRICTIVE TO app_user
  USING (NOT app_assignment_scoped() OR converted_job_id IS NULL
         OR EXISTS (SELECT 1 FROM jobs j WHERE j.id = converted_job_id))
  WITH CHECK (NOT app_assignment_scoped() OR converted_job_id IS NULL
         OR EXISTS (SELECT 1 FROM jobs j WHERE j.id = converted_job_id));
CREATE POLICY assigned_revision ON quote_revisions AS RESTRICTIVE TO app_user
  USING (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_id))
  WITH CHECK (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_id));
CREATE POLICY assigned_quote_line ON quote_lines AS RESTRICTIVE TO app_user
  USING (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM quote_revisions r WHERE r.id = revision_id))
  WITH CHECK (NOT app_assignment_scoped() OR EXISTS (SELECT 1 FROM quote_revisions r WHERE r.id = revision_id));
CREATE POLICY assigned_credit_use ON credit_uses AS RESTRICTIVE TO app_user
  USING (NOT app_assignment_scoped() OR
    (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id)
     AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = credit_invoice_id)))
  WITH CHECK (NOT app_assignment_scoped() OR
    (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id)
     AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = credit_invoice_id)));
