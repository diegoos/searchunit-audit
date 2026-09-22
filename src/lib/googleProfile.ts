import { getDomain } from 'tldts';

const PROFILE_BASE = 'https://profile.google.com/cp/';

/**

 * Strips scheme and path from a raw domain input for profile URL building.

 */
export function cleanProfileDomain(raw: string): string {
  const trimmed = raw.trim();

  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const hostname = new URL(withScheme).hostname.replace(/\.$/, '').toLowerCase();

    return hostname;
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
  }
}

/** Returns the registrable apex domain for a hostname (via tldts). */
export function getApexDomain(hostname: string): string {
  return getDomain(hostname) ?? hostname;
}

/** Returns true when hostname is a subdomain of its apex domain. */
export function isSubdomain(hostname: string): boolean {
  return hostname !== getApexDomain(hostname);
}

/** Encodes a non-negative integer as protobuf varint bytes for the Google Profile URL payload. */

function toVarint(value: number): number[] {
  const out: number[] = [];
  let n = value;

  while (n >= 128) {
    out.push((n % 128) + 128);
    n = Math.floor(n / 128);
  }

  out.push(n % 128);

  return out;
}

export interface GoogleProfileSummary {
  domain: string;
  apex: string;
  isSubdomain: boolean;
  profileUrl: string;
}

/** Domain fields plus the Google Business Profile URL (no network fetch). */
export function googleProfileSummary(rawDomain: string): GoogleProfileSummary {
  const domain = cleanProfileDomain(rawDomain);

  return {
    domain,
    apex: getApexDomain(domain),
    isSubdomain: isSubdomain(domain),
    profileUrl: buildGoogleProfileUrl(domain),
  };
}

/** Profile for the audited page host (preserves www from the final URL). */
export function googleProfileFromAuditedUrl(auditedUrl: string): GoogleProfileSummary {
  return googleProfileSummary(new URL(auditedUrl).hostname);
}

/** Field/value rows shared by the command table and the audit report. */
export function googleProfileFields(profile: GoogleProfileSummary): [string, string][] {
  return [
    ['domain', profile.domain],
    ['apex', profile.apex],
    ['subdomain', profile.isSubdomain ? 'yes' : 'no'],
    ['profile URL', profile.profileUrl],
  ];
}

/** Builds a Google Business Profile URL from a domain using protobuf encoding. */
export function buildGoogleProfileUrl(rawDomain: string): string {
  const domain = cleanProfileDomain(rawDomain);
  const domainBytes = new TextEncoder().encode(domain);
  const inner = [0x0a, ...toVarint(domainBytes.length), ...domainBytes];
  const outer = [0x12, ...toVarint(inner.length), ...inner];
  let bin = '';

  for (const byte of Uint8Array.from(outer)) {
    bin += String.fromCharCode(byte);
  }

  return PROFILE_BASE + btoa(bin);
}
