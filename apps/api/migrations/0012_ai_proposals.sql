-- AI helpers and the approvals inbox. "AI drafts, Joe decides": helpers can only write
-- proposals. A proposal shows what it will do; the owner approves, edits or discards it.
-- Approved emails wait in "held" for two minutes (Stop puts them back) before sending.
-- Every model call, proposal and decision is logged.

CREATE TABLE ai_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  purpose        text NOT NULL CHECK (purpose IN ('bill_read', 'reply_email', 'overdue_reminder', 'quote_draft', 'price_update')),
  provider       text NOT NULL,
  model          text NOT NULL,
  prompt         text NOT NULL,
  response       text,
  status         text NOT NULL CHECK (status IN ('ok', 'error', 'refused')),
  error          text,
  input_tokens   int NOT NULL DEFAULT 0,
  output_tokens  int NOT NULL DEFAULT 0,
  -- Thousandths of a penny, so tiny calls still add up against the monthly cap.
  cost_millipence bigint NOT NULL DEFAULT 0,
  duration_ms    int NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ai_calls_month_idx ON ai_calls (tenant_id, created_at);

CREATE TABLE proposals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  agent        text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('reply_email', 'overdue_reminder', 'quote_draft', 'price_update')),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'held', 'sent', 'send_blocked', 'applied', 'discarded')),
  title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  -- Plain words: what approving will do.
  summary      text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1000),
  payload      jsonb NOT NULL,
  diff         jsonb,
  source_type  text,
  source_id    uuid,
  ai_call_id   uuid,
  hold_until   timestamptz,
  decided_by   uuid REFERENCES users (id),
  decided_at   timestamptz,
  result       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ai_call_id) REFERENCES ai_calls (tenant_id, id),
  CHECK ((status = 'held') = (hold_until IS NOT NULL)),
  CHECK (status IN ('pending') OR decided_by IS NOT NULL)
);
-- One open draft per thing (an invoice's reminder, an enquiry's quote, a bill's prices).
CREATE UNIQUE INDEX proposals_one_open ON proposals (tenant_id, kind, source_id)
  WHERE status IN ('pending', 'held') AND source_id IS NOT NULL;
CREATE INDEX proposals_status_idx ON proposals (tenant_id, status, created_at DESC);
CREATE INDEX proposals_held_idx ON proposals (hold_until) WHERE status = 'held';

CREATE TABLE proposal_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  proposal_id  uuid NOT NULL,
  event        text NOT NULL CHECK (event IN ('created', 'edited', 'approved', 'stopped', 'sent', 'send_blocked', 'applied', 'discarded')),
  by_user      uuid REFERENCES users (id),
  data         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES proposals (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX proposal_events_idx ON proposal_events (tenant_id, proposal_id, created_at);

CREATE TRIGGER proposals_updated BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER proposals_version BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION bump_version();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_calls', 'proposals', 'proposal_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
-- The logs are append-only for the app.
GRANT SELECT, INSERT ON ai_calls, proposal_events TO app_user;
GRANT SELECT, INSERT, UPDATE ON proposals TO app_user;
