import type { ZodError } from 'zod';

/** An error safe to show the user. `code` is stable for clients; `message` is plain English. */
export class AppError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
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
