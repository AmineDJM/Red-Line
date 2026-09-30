import type { z } from 'zod';
import { HttpError } from '../auth/auth.js';

export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const msg = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(corps)'} : ${i.message}`)
      .join(' ; ');
    throw new HttpError(400, 'invalid_body', msg);
  }
  return r.data as z.output<S>;
}

export function unavailable(code: string, message: string): HttpError {
  return new HttpError(503, code, message);
}
