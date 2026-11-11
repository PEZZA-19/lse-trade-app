-- 0003_auth_settings: passwordless sign-in (magic links), sessions, rate limiting, business settings.
--
-- Auth tables are NOT granted to app_user. The app role can only reach them through the
-- SECURITY DEFINER functions below, so a SQL bug in a route can never read or forge sessions.
-- Only SHA-256 hashes of tokens are stored; the raw values exist only in the email/cookie.

/* ------------------------------ sign-in ------------------------------ */

CREATE TABLE login_tokens (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_user_idx ON login_tokens (user_id);

CREATE TABLE sessions (
  id_hash       text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id     uuid REFERENCES tenants (id) ON DELETE SET NULL,
  csrf_token    text NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE rate_limits (
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  hits          int NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

ALTER TABLE login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies and no grants: only the definer functions (owned by the schema owner) touch these.

-- users and memberships have FORCE ROW LEVEL SECURITY, which also applies to their owner unless the
-- owner is a superuser (true locally, not on Neon). The definer functions run as the owner, so give the
-- owner explicit access. app_user can never become the owner, so this opens nothing to the API.
CREATE POLICY owner_access ON users
  USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.users'::regclass));
CREATE POLICY owner_access ON memberships
  USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.memberships'::regclass));

-- Issues a login token for a known user. Returns the user's id, or NULL for an unknown email
-- (the API answers the same either way, so emails cannot be probed).
CREATE OR REPLACE FUNCTION auth_issue_login_token(p_email text, p_token_hash text, p_ttl_seconds int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = lower(trim(p_email));
  IF v_user IS NULL THEN RETURN NULL; END IF;
  -- Only members of at least one business can sign in (no self sign-up yet).
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = v_user) THEN RETURN NULL; END IF;
  DELETE FROM login_tokens WHERE user_id = v_user AND (used_at IS NOT NULL OR expires_at < now());
  INSERT INTO login_tokens (token_hash, user_id, expires_at)
  VALUES (p_token_hash, v_user, now() + make_interval(secs => p_ttl_seconds));
  RETURN v_user;
END $$;

-- Single use: marks the token used and opens a session in one statement. NULL if invalid/expired/used.
CREATE OR REPLACE FUNCTION auth_redeem_login_token(
  p_token_hash text, p_session_hash text, p_csrf text, p_user_agent text, p_ttl_seconds int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  UPDATE login_tokens SET used_at = now()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  RETURNING user_id INTO v_user;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  -- Start in the business they belong to (if several, the oldest membership; they can switch).
  SELECT tenant_id INTO v_tenant FROM memberships WHERE user_id = v_user ORDER BY created_at, tenant_id LIMIT 1;
  INSERT INTO sessions (id_hash, user_id, tenant_id, csrf_token, user_agent, expires_at)
  VALUES (p_session_hash, v_user, v_tenant, p_csrf, left(p_user_agent, 300), now() + make_interval(secs => p_ttl_seconds));
  RETURN v_user;
END $$;

-- Looks up a live session and slides its expiry (at most once a minute, to limit writes).
CREATE OR REPLACE FUNCTION auth_session(p_session_hash text, p_ttl_seconds int)
RETURNS TABLE (user_id uuid, tenant_id uuid, role text, csrf_token text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE sessions s SET last_seen_at = now(), expires_at = now() + make_interval(secs => p_ttl_seconds)
   WHERE s.id_hash = p_session_hash AND s.expires_at > now() AND s.last_seen_at < now() - interval '1 minute';
  RETURN QUERY
    SELECT s.user_id, s.tenant_id, m.role, s.csrf_token
      FROM sessions s
      LEFT JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
     WHERE s.id_hash = p_session_hash AND s.expires_at > now();
END $$;

CREATE OR REPLACE FUNCTION auth_switch_tenant(p_session_hash text, p_tenant uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE sessions s SET tenant_id = p_tenant
   WHERE s.id_hash = p_session_hash AND s.expires_at > now()
     AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = s.user_id AND m.tenant_id = p_tenant);
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION auth_end_session(p_session_hash text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM sessions WHERE id_hash = p_session_hash;
$$;

-- Fixed-window rate limit. Returns true if this hit is allowed.
CREATE OR REPLACE FUNCTION rate_limit_hit(p_key text, p_window_seconds int, p_max int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_start timestamptz; v_hits int;
BEGIN
  v_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO rate_limits (key, window_start, hits) VALUES (p_key, v_start, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
  RETURNING hits INTO v_hits;
  -- Opportunistic cleanup of old windows.
  IF random() < 0.01 THEN DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'; END IF;
  RETURN v_hits <= p_max;
END $$;

REVOKE ALL ON FUNCTION auth_issue_login_token(text, text, int), auth_redeem_login_token(text, text, text, text, int),
  auth_session(text, int), auth_switch_tenant(text, uuid), auth_end_session(text), rate_limit_hit(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_issue_login_token(text, text, int), auth_redeem_login_token(text, text, text, text, int),
  auth_session(text, int), auth_switch_tenant(text, uuid), auth_end_session(text), rate_limit_hit(text, int, int) TO app_user;

/* -------------------------- business settings ------------------------- */

ALTER TABLE tenants
  ADD COLUMN legal_name           text,
  ADD COLUMN address              text,
  ADD COLUMN phone                text,
  ADD COLUMN email                text CHECK (email IS NULL OR email = lower(email)),
  ADD COLUMN bank_account_name    text,
  ADD COLUMN bank_sort_code       text CHECK (bank_sort_code IS NULL OR bank_sort_code ~ '^\d{2}-\d{2}-\d{2}$'),
  ADD COLUMN bank_account_number  text CHECK (bank_account_number IS NULL OR bank_account_number ~ '^\d{8}$'),
  ADD COLUMN payment_terms_days   int NOT NULL DEFAULT 14 CHECK (payment_terms_days BETWEEN 0 AND 120),
  ADD COLUMN tax_rate_bp          int NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  ADD COLUMN quote_terms          text,
  ADD COLUMN invoice_terms        text;

-- Members may see the names of every business they belong to (for the business switcher).
-- SELECT only: changes remain limited to the active business by tenant_self.
CREATE POLICY tenant_member_read ON tenants FOR SELECT
  USING (id IN (SELECT tenant_id FROM memberships WHERE user_id = app_current_user()));
