import { isLoopbackHost } from '../ip-policy.ts';

/**
 * A loopback target (dev server). Browsers treat it as a secure context, but
 * its HTTPS state is not judged: only the production URL is.
 */
export function isLocalTarget(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Served over HTTPS, or a loopback target that browsers treat as secure. */
export function servedSecurely(url: string): boolean {
  return url.startsWith('https://') || isLocalTarget(url);
}
