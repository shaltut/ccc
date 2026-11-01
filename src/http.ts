import type { Context } from 'hono';
import { z } from 'zod';
import { httpError } from './errors.ts';
import { SESSION_NAME } from './sessions.ts';

/** Owner-supplied project names: same pattern as session names, trimmed and lower-cased. */
export const PROJECT = z.string().trim().toLowerCase().regex(SESSION_NAME, 'Invalid project name');

/** Parses the JSON body with the schema; bad JSON is a 400, not a 500. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw httpError(400, 'invalid_json', 'Request body must be JSON');
  }
  return schema.parse(raw);
}
