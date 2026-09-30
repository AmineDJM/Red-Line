import { ApiError } from '../api/client';
import { T, fmt } from '../i18n';
import { readableIssues, type Issue } from './validation';

/** Message lisible pour une erreur d'API (ou toute autre exception). */
export function errorMessage(e: unknown, requiredRole?: string): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const x = T.errors;
  switch (e.status) {
    case 0:
      return x.network;
    case 401:
      return x.unauthorized;
    case 403:
      return fmt(x.forbidden, { role: requiredRole ?? '—' });
    case 404:
      return x.notFound;
    case 409:
      return e.message && e.message !== 'Conflict' ? `${x.conflict} (${e.message})` : x.conflict;
    case 400:
    case 422: {
      const issues = Array.isArray(e.details) ? (e.details as Issue[]) : [];
      const valid = issues.filter(
        (i) => i && Array.isArray(i.path) && typeof i.message === 'string',
      );
      if (valid.length) {
        return `${x.validation} ${readableIssues(valid)
          .map((i) => `${i.label} : ${i.message}`)
          .join(' ; ')}`;
      }
      return `${x.validation} ${e.message}`;
    }
    default:
      return fmt(x.server, { status: e.status }) + (e.message ? ` ${e.message}` : '');
  }
}
