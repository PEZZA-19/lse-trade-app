import type { Tx } from '../db/client';
import { AppError } from './errors';
import type { Auth } from './types';

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Makes a write safe to retry (double taps, flaky signal, offline queue replays).
 * Same key + same request -> the original response is returned, and the work is not repeated.
 * Same key + different request -> 422. Requests sharing a key are serialised by an advisory lock.
 */
export async function idempotent<T>(
  tx: Tx,
  auth: Auth,
  key: string | undefined,
  request: string,
  run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!key) return { ...(await run()), replayed: false };
  if (key.length < 8 || key.length > 200)
    throw new AppError(400, 'bad_idempotency_key', 'Idempotency-Key must be 8-200 characters');
  const hash = await sha256(request);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${auth.tenantId + ':' + key}, 0))`;
  const [hit] = await tx<{ requestHash: string; statusCode: number; response: T }[]>`
    SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = ${key}`;
  if (hit) {
    if (hit.requestHash !== hash)
      throw new AppError(
        422,
        'idempotency_mismatch',
        'This Idempotency-Key was already used for a different request',
      );
    return { status: hit.statusCode, body: hit.response, replayed: true };
  }
  const result = await run();
  await tx`INSERT INTO idempotency_keys (tenant_id, key, request_hash, status_code, response)
           VALUES (${auth.tenantId}, ${key}, ${hash}, ${result.status}, ${tx.json(result.body as never)})`;
  return { ...result, replayed: false };
}
