import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ApiError } from '../api/client';
import { useRequestLink, useSession, useVerifyLink } from '../api/hooks';
import { Button, List, Section, TextField } from '../components/ui';

/** Passwordless: enter your email, tap the link we send. No password to forget or leak. */
export function SignInScreen() {
  const session = useSession();
  const [email, setEmail] = useState('');
  const request = useRequestLink();
  const fieldError = request.error instanceof ApiError ? request.error.fields.email : undefined;

  if (session.data) return <Navigate to="/home" replace />;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!email.trim() || request.isPending) return;
    request.mutate(email.trim());
  };

  return (
    <div className="auth">
      <img src="/icon-192.png" alt="" className="auth__icon" />
      <h1 className="auth__title">Sign in</h1>
      {request.isSuccess ? (
        <div role="status">
          <p className="auth__lead">
            Check your email. If <strong>{request.variables}</strong> has an account, a sign-in link
            is on its way. It works once and expires in 15 minutes.
          </p>
          {import.meta.env.DEV && (
            <p className="auth__hint">
              Development: no email is sent. Run `pnpm sign-in-link` to get the link.
            </p>
          )}
          <Button variant="plain" onClick={() => request.reset()}>
            Use a different email
          </Button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <p className="auth__lead">We’ll email you a link. No password needed.</p>
          <Section
            footer={
              request.isError && !fieldError ? (
                <span style={{ color: 'var(--red)' }}>{request.error.message}</span>
              ) : undefined
            }
          >
            <List className="form-list">
              <TextField
                label="Email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@business.com"
                error={fieldError}
                autoFocus
              />
            </List>
          </Section>
          <Button type="submit" block large loading={request.isPending} disabled={!email.trim()}>
            Email me a sign-in link
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * Landing page for the emailed link. The token is in the URL fragment (never sent to servers or logs).
 * Signing in needs a tap, so email link-scanners that open the page can't use up the link.
 */
export function VerifyScreen() {
  const navigate = useNavigate();
  const verify = useVerifyLink();
  const [token] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '',
  );
  useEffect(() => {
    // Remove the token from the address bar and history.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  return (
    <div className="auth">
      <img src="/icon-192.png" alt="" className="auth__icon" />
      <h1 className="auth__title">Sign in</h1>
      {!token ? (
        <p className="auth__lead">This link is incomplete. Please ask for a new one.</p>
      ) : verify.isError ? (
        <p className="auth__lead" role="alert">
          {verify.error.message}
        </p>
      ) : (
        <>
          <p className="auth__lead">Tap continue to finish signing in on this device.</p>
          <Button
            block
            large
            loading={verify.isPending || verify.isSuccess}
            onClick={() =>
              verify.mutate(token, { onSuccess: () => navigate('/home', { replace: true }) })
            }
          >
            Continue
          </Button>
        </>
      )}
      {(verify.isError || !token) && (
        <Button variant="plain" onClick={() => navigate('/sign-in', { replace: true })}>
          Get a new link
        </Button>
      )}
    </div>
  );
}
