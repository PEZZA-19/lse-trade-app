-- Enquiries (new work asking to happen) and the public website form that creates them.
CREATE TABLE enquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('manual', 'phone', 'email', 'web_form')),
  status          text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'actioned', 'converted', 'rejected')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email           text CHECK (char_length(email) <= 254),
  phone           text CHECK (char_length(phone) <= 40),
  address         text CHECK (char_length(address) <= 300),
  message         text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  customer_id     uuid REFERENCES customers (id),
  converted_to    text CHECK (converted_to IN ('quote', 'job', 'appointment')),
  quote_id        uuid REFERENCES quotes (id),
  job_id          uuid REFERENCES jobs (id),
  appointment_id  uuid REFERENCES appointments (id),
  reject_reason   text CHECK (char_length(reject_reason) <= 500),
  decided_by      uuid REFERENCES users (id),
  decided_at      timestamptz,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK ((status = 'converted') = (converted_to IS NOT NULL)),
  CHECK (status = 'todo' OR decided_at IS NOT NULL)
);
CREATE INDEX enquiries_status_idx ON enquiries (tenant_id, status, created_at DESC);

CREATE TRIGGER enquiries_updated BEFORE UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER enquiries_version BEFORE UPDATE ON enquiries FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE enquiries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON enquiries
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON enquiries TO app_user;

-- The website form posts to /api/public/enquiries/<key>. The key only identifies the business;
-- the owner can replace it at any time (old key stops working).
ALTER TABLE tenants ADD COLUMN enquiry_form_key text UNIQUE
  CHECK (enquiry_form_key ~ '^[A-Za-z0-9_-]{20,64}$');

-- The public form has no session, so it can't pass RLS: this function is the one narrow door.
-- It inserts a web enquiry for the business that owns the key, and nothing else.
CREATE OR REPLACE FUNCTION public_enquiry_submit(
  p_form_key text, p_name text, p_email text, p_phone text, p_address text, p_message text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE enquiry_form_key = p_form_key;
  IF v_tenant IS NULL THEN RETURN false; END IF;
  INSERT INTO enquiries (tenant_id, source, name, email, phone, address, message)
  VALUES (v_tenant, 'web_form', p_name, p_email, p_phone, p_address, p_message);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public_enquiry_submit(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_enquiry_submit(text, text, text, text, text, text) TO app_user;
