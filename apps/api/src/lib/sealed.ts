/**
 * Sealing secrets (calendar refresh tokens) before they reach the database: AES-256-GCM with a key
 * that only the Worker has (secret CALENDAR_TOKEN_KEY, 32 random bytes, base64). The database
 * holds "v1.<iv>.<ciphertext>" and can't read it. Web Crypto only, so it runs on Workers and Node.
 */
const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (s: string) => {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export class SealError extends Error {}

/** Imports the key from its base64 (or base64url) text. Throws when it isn't 32 bytes. */
export async function sealingKey(base64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = unb64(base64.trim());
  } catch {
    throw new SealError('CALENDAR_TOKEN_KEY is not valid base64.');
  }
  if (raw.length !== 32)
    throw new SealError(
      'CALENDAR_TOKEN_KEY must be 32 random bytes (base64), e.g. `openssl rand -base64 32`.',
    );
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `context` (e.g. the person's id) is bound in, so a sealed value can't be moved to someone else. */
export async function seal(key: CryptoKey, plain: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(plain),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function unseal(key: CryptoKey, sealed: string, context: string): Promise<string> {
  const [v, iv, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !ct) throw new SealError('Not a sealed value.');
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(context) },
      key,
      unb64(ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new SealError('The sealed value could not be opened (wrong key or tampered).');
  }
}

/** PKCE (RFC 7636): the S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}
