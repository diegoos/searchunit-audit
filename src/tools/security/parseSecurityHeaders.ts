/** Raw security header values extracted from the HTTP response. */
export interface SecurityHeaderRaw {
  hsts: string | null;
  csp: string | null;
  cspReportOnly: string | null;
  xFrame: string | null;
  xContentType: string | null;
  referrerPolicy: string | null;
  permissionsPolicy: string | null;
  coop: string | null;
  coep: string | null;
  corp: string | null;
  xRobotsTag: string | null;
}

/**
 * Reads security-related response headers from the fetch result.
 * Expects lowercase keys (`fetchPublicUrl` already normalizes them).
 */
export function parseSecurityHeaders(
  headers: Record<string, string> | undefined,
): SecurityHeaderRaw {
  const h = headers ?? {};

  return {
    hsts: h['strict-transport-security'] ?? null,
    csp: h['content-security-policy'] ?? null,
    cspReportOnly: h['content-security-policy-report-only'] ?? null,
    xFrame: h['x-frame-options'] ?? null,
    xContentType: h['x-content-type-options'] ?? null,
    referrerPolicy: h['referrer-policy'] ?? null,
    permissionsPolicy: h['permissions-policy'] ?? null,
    coop: h['cross-origin-opener-policy'] ?? null,
    coep: h['cross-origin-embedder-policy'] ?? null,
    corp: h['cross-origin-resource-policy'] ?? null,
    xRobotsTag: h['x-robots-tag'] ?? null,
  };
}

/** Parsed HSTS directive values. */
export interface HstsDirectives {
  maxAge: number | null;
  includeSubDomains: boolean;
  preload: boolean;
}

/**
 * Parses HSTS directives into a structured shape.
 * HSTS grammar has no commas; Fetch may join duplicate headers with ", ",
 * so only the first comma-separated header value is parsed. Tokens within
 * that value are split on `;` and matched by exact directive name.
 */
export function parseHstsDirectives(value: string | null): HstsDirectives {
  if (!value) {
    return { maxAge: null, includeSubDomains: false, preload: false };
  }

  // Fetch joins duplicates as "max-age=A, max-age=B; …" — take the first header.

  const firstHeader = value.split(',')[0] ?? value;
  let maxAge: number | null = null;
  let includeSubDomains = false;
  let preload = false;

  for (const raw of firstHeader.split(';')) {
    const token = raw.trim();

    if (!token) {
      continue;
    }

    const maxAgeMatch = /^max-age\s*=\s*(\d+)$/i.exec(token);

    if (maxAgeMatch) {
      maxAge = Number(maxAgeMatch[1]);
      continue;
    }

    if (/^includeSubDomains$/i.test(token)) {
      includeSubDomains = true;
      continue;
    }

    if (/^preload$/i.test(token)) {
      preload = true;
    }
  }

  return { maxAge, includeSubDomains, preload };
}

/**
 * Splits a CSP header into a map of directive → sources.
 * Fetch joins duplicate CSP headers with ", "; treat those as directive separators.
 * When the same directive appears twice (Fetch join), sources are merged.
 * Bare/boolean directives (no sources) after a comma are also split.
 */
export function parseCspDirectives(value: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();

  if (!value) {
    return out;
  }

  // e.g. "script-src 'self', upgrade-insecure-requests" → semicolon form

  const normalized = value.replace(/,(?=\s*[\w-]+(?:\s|$))/g, ';');

  for (const part of normalized.split(';')) {
    const trimmed = part.trim();

    if (!trimmed) {
      continue;
    }

    const spaceIdx = trimmed.indexOf(' ');

    if (spaceIdx === -1) {
      const directive = trimmed.toLowerCase();

      if (!out.has(directive)) {
        out.set(directive, []);
      }
    } else {
      const directive = trimmed.slice(0, spaceIdx).toLowerCase();
      const sources = trimmed
        .slice(spaceIdx + 1)
        .trim()
        .split(/\s+/)
        .map((s) => s.replace(/,+$/, ''))
        .filter(Boolean);

      const prev = out.get(directive) ?? [];

      out.set(directive, [...prev, ...sources]);
    }
  }

  return out;
}
