import { REDIRECT_STATUSES } from '../../lib/fetch';

/**
 * Derives HTTPS and redirect flags from a successful page fetch.
 *
 * @param page - Final URL and HTTP status
 * @returns Context flags used by the security headers analyzer
 */
export function buildAnalyzeContext(page: { finalUrl: string; status: number }): {
  https: boolean;
  redirectNotFollowed: boolean;
} {
  const https = new URL(page.finalUrl).protocol === 'https:';
  const redirectNotFollowed = REDIRECT_STATUSES.has(page.status);

  return { https, redirectNotFollowed };
}
