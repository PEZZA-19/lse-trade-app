-- 0001_core: tenants, users, customers, sites, numbering, quotes (+revisions, lines), jobs (+lines).
--
-- Conventions
--   * Every business row carries tenant_id and is protected by row-level security (RLS).
--   * Child rows reference parents by (tenant_id, id) so a row can never point at another tenant's data.
--   * Money is whole pence (bigint). Quantities are thousandths (bigint). Markups are basis points (int).
--   * The API connects as a member of app_user (not a superuser, not the table owner), so RLS always applies.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

/* ------------------------------ tenancy ------------------------------ */

CREATE TABLE tenants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,60}$'),
  default_markup_bp  int  NOT NULL DEFAULT 13000 CHECK (default_markup_bp BETWEEN 10000 AND 100000),
  labour_rate_pence  bigint NOT NULL DEFAULT 4500 CHECK (labour_rate_pence >= 0),
  quote_valid_days   int  NOT NULL DEFAULT 30 CHECK (quote_valid_days BETWEEN 1 AND 365),
  timezone           text NOT NULL DEFAULT 'Europe/Guernsey',
  currency           text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE memberships (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'staff', 'subcontractor', 'accountant')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

/* ----------------------------- customers ----------------------------- */

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  email            text CHECK (email IS NULL OR email = lower(email)),
  phone            text,
  billing_address  text,
  notes            text,
  markup_bp        int CHECK (markup_bp IS NULL OR markup_bp BETWEEN 10000 AND 100000),
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX customers_tenant_name_idx ON customers (tenant_id, lower(name));

CREATE TABLE sites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  customer_id  uuid NOT NULL,
  label        text,
  address      text NOT NULL CHECK (length(address) >= 1),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sites_customer_idx ON sites (tenant_id, customer_id);

/* ----------------------------- numbering ----------------------------- */

CREATE TABLE number_sequences (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('quote', 'job', 'invoice', 'credit_note')),
  prefix        text NOT NULL DEFAULT '' CHECK (length(prefix) <= 12),
  padding       int  NOT NULL DEFAULT 0 CHECK (padding BETWEEN 0 AND 10),
  next_value    bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  gaps_allowed  boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind)
);

-- Allocates the next number for (current tenant, kind) atomically.
-- The UPDATE takes a row lock, so concurrent callers queue and each gets a distinct value.
-- Because it runs inside the caller's transaction, a rolled-back document releases its
-- number (no gap), which is what invoices need. SECURITY INVOKER: RLS still applies.
CREATE OR REPLACE FUNCTION allocate_number(p_kind text)
RETURNS TABLE (value bigint, formatted text)
LANGUAGE plpgsql AS $$
DECLARE
  v_prefix text; v_padding int; v_value bigint;
BEGIN
  UPDATE number_sequences
     SET next_value = next_value + 1, updated_at = now()
   WHERE tenant_id = app_current_tenant() AND kind = p_kind
  RETURNING next_value - 1, prefix, padding INTO v_value, v_prefix, v_padding;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'No % number sequence for this business', p_kind USING ERRCODE = 'P0002';
  END IF;
  value := v_value;
  formatted := v_prefix || lpad(v_value::text, greatest(v_padding, length(v_value::text)), '0');
  RETURN NEXT;
END $$;

/* ------------------------------- quotes ------------------------------ */

CREATE TABLE quotes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  number             text NOT NULL,
  seq_value          bigint,
  legacy_number      text,
  customer_id        uuid NOT NULL,
  site_id            uuid,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'sent', 'accepted', 'converted', 'declined', 'expired')),
  current_revision   int NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  accepted_revision  int,
  accepted_at        timestamptz,
  converted_job_id   uuid UNIQUE,
  converted_at       timestamptz,
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  CHECK ((status = 'converted') = (converted_job_id IS NOT NULL)),
  CHECK (status NOT IN ('accepted', 'converted') OR accepted_revision IS NOT NULL)
);
CREATE INDEX quotes_tenant_status_idx ON quotes (tenant_id, status, updated_at DESC);
CREATE INDEX quotes_customer_idx ON quotes (tenant_id, customer_id);

CREATE TABLE quote_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  quote_id          uuid NOT NULL,
  revision          int  NOT NULL CHECK (revision >= 1),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  notes             text,
  valid_days        int  NOT NULL DEFAULT 30 CHECK (valid_days BETWEEN 1 AND 365),
  default_markup_bp int  NOT NULL CHECK (default_markup_bp BETWEEN 10000 AND 100000),
  accepted_options  text[] NOT NULL DEFAULT '{}',
  -- Totals are computed by the API with the shared pricing rules and stored for fast lists.
  core_total_pence  bigint NOT NULL DEFAULT 0,
  total_pence       bigint NOT NULL DEFAULT 0,
  sent_at           timestamptz,
  superseded_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (quote_id, revision),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE quote_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  revision_id       uuid NOT NULL,
  position          int  NOT NULL CHECK (position >= 0),
  kind              text NOT NULL CHECK (kind IN ('labour', 'material', 'carriage', 'pc_sum')),
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  qty_milli         bigint NOT NULL DEFAULT 1000,
  unit_cost_pence   bigint,
  markup_bp         int CHECK (markup_bp IS NULL OR markup_bp BETWEEN 10000 AND 100000),
  unit_price_pence  bigint,
  option_label      text,
  tax_rate_bp       int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  UNIQUE (revision_id, position),
  FOREIGN KEY (tenant_id, revision_id) REFERENCES quote_revisions (tenant_id, id) ON DELETE CASCADE
);

/* -------------------------------- jobs ------------------------------- */

CREATE TABLE jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  number                 text NOT NULL,
  seq_value              bigint,
  customer_id            uuid NOT NULL,
  site_id                uuid,
  title                  text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description            text,
  status                 text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  place_of_work          text NOT NULL DEFAULT 'sark' CHECK (place_of_work IN ('sark', 'guernsey', 'other')),
  -- A quote can be the source of at most one job: this UNIQUE is the database-level guarantee.
  source_quote_id        uuid UNIQUE,
  source_quote_revision  int,
  created_by             uuid REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id),
  FOREIGN KEY (tenant_id, source_quote_id) REFERENCES quotes (tenant_id, id),
  CHECK ((source_quote_id IS NULL) = (source_quote_revision IS NULL))
);
CREATE INDEX jobs_tenant_status_idx ON jobs (tenant_id, status, updated_at DESC);
CREATE INDEX jobs_customer_idx ON jobs (tenant_id, customer_id);

ALTER TABLE quotes
  ADD FOREIGN KEY (tenant_id, converted_job_id) REFERENCES jobs (tenant_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE job_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  job_id                uuid NOT NULL,
  position              int  NOT NULL CHECK (position >= 0),
  kind                  text NOT NULL CHECK (kind IN ('labour', 'material', 'carriage', 'pc_sum')),
  description           text NOT NULL,
  qty_milli             bigint NOT NULL,
  unit_cost_pence       bigint,
  unit_sell_pence       bigint NOT NULL,
  total_pence           bigint NOT NULL,
  source                text NOT NULL CHECK (source IN ('quote', 'manual')),
  source_quote_line_id  uuid REFERENCES quote_lines (id) ON DELETE SET NULL,
  UNIQUE (job_id, position),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id) ON DELETE CASCADE
);

/* ----------------------- idempotency and audit ----------------------- */

-- Retry-safe writes: a client sends Idempotency-Key; a replay returns the stored response.
CREATE TABLE idempotency_keys (
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash  text NOT NULL,
  status_code   int  NOT NULL,
  response      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users (id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity, entity_id);

/* ------------------------------ triggers ----------------------------- */

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','customers','sites','quotes','quote_revisions','jobs'] LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

/* ------------------------- row-level security ------------------------ */

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_current_tenant());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users USING (
  id = app_current_user()
  OR id IN (SELECT user_id FROM memberships WHERE tenant_id = app_current_tenant())
);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
-- A signed-in user can see their own memberships (to pick a business); within a business, all of its members.
CREATE POLICY memberships_visible ON memberships
  USING (user_id = app_current_user() OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customers','sites','number_sequences','quotes','quote_revisions','quote_lines',
                           'jobs','job_lines','idempotency_keys','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;

/* ------------------------------- grants ------------------------------ */

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  customers, sites, quotes, quote_revisions, quote_lines, jobs, job_lines, idempotency_keys
  TO app_user;
GRANT SELECT, UPDATE ON tenants, number_sequences TO app_user;
GRANT SELECT ON users, memberships TO app_user;
GRANT SELECT, INSERT ON audit_log TO app_user;
GRANT EXECUTE ON FUNCTION allocate_number(text), app_current_tenant(), app_current_user() TO app_user;
