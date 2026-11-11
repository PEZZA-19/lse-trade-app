import type { z } from 'zod';
import { fromZod, invalid } from './errors';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}

export async function jsonBody(req: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw invalid('Request body must be valid JSON');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path ids that are not UUIDs are simply "not found", never a database error. */
export function isUuid(s: string): boolean {
  return UUID.test(s);
}
