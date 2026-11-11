import type { ZodError } from 'zod';

/** An error safe to show the user. `code` is stable for clients; `message` is plain English. */
export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const invalid = (message: string, details?: unknown) =>
  new AppError(422, 'validation_failed', message, details);

export function fromZod(err: ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  const first = err.issues[0];
  return invalid(first ? first.message : 'Invalid input', { fields });
}

/**
 * Optimistic concurrency: the client edited version `expected`; if the row has moved on, refuse and
 * return the current record so the app can apply its conflict rules (see apps/web/src/offline).
 */
export function assertVersion(
  expected: number | undefined,
  actual: number,
  current: () => Promise<unknown>,
) {
  if (expected === undefined || expected === actual) return Promise.resolve();
  return current().then((record) => {
    throw new AppError(
      409,
      'version_conflict',
      'This was changed on another device since you edited it.',
      {
        currentVersion: actual,
        current: record,
      },
    );
  });
}
