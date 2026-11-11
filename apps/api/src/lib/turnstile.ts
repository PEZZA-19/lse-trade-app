/**
 * Cloudflare Turnstile check for the public enquiry form. The stub is used everywhere for now
 * (no Cloudflare account): it passes any token except "stub-fail", so tests can exercise both
 * paths. The real verifier is ready for when a site key exists.
 */
export interface TurnstileVerifier {
  readonly name: string;
  verify(token: string | undefined, ip: string): Promise<boolean>;
}

export class StubTurnstile implements TurnstileVerifier {
  readonly name = 'stub';
  async verify(token: string | undefined) {
    return !!token && token !== 'stub-fail';
  }
}

export class CloudflareTurnstile implements TurnstileVerifier {
  readonly name = 'cloudflare';
  constructor(
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async verify(token: string | undefined, ip: string) {
    if (!token) return false;
    const body = new FormData();
    body.set('secret', this.secret);
    body.set('response', token);
    if (ip !== 'unknown') body.set('remoteip', ip);
    const res = await this.fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!res.ok) return false;
    return ((await res.json()) as { success?: boolean }).success === true;
  }
}
