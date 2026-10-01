import ipaddr from 'ipaddr.js';

const BLOCKED_IP_RANGES = new Set([
  'unspecified',

  'loopback',

  'private',

  'linkLocal',

  'uniqueLocal',

  'broadcast',

  'carrierGradeNat',

  'reserved',

  'rfc6052',

  'rfc6145',

  'multicast',

  'deprecatedSiteLocal',
]);

/** Hostname with brackets and a trailing dot removed. Empty input stays empty. */
export function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();

  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }

  return host;
}

/** True for localhost and *.localhost. Other names, including .local, are false. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);

  return host === 'localhost' || host.endsWith('.localhost');
}

/** True for localhost, .local, .internal. Empty input fails closed. */
export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);

  if (!host) {
    return true;
  }

  return host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal');
}

/** True for 127.0.0.0/8, ::1, and IPv4-mapped loopback. Invalid input is false. */
export function isLoopbackIpString(ip: string): boolean {
  const normalized = normalizeIp(ip);

  if (!normalized || !ipaddr.isValid(normalized)) {
    return false;
  }

  return ipaddr.process(normalized).range() === 'loopback';
}

/** True when the address must not be fetched. Invalid input fails closed. */
export function isBlockedIpString(ip: string): boolean {
  const normalized = normalizeIp(ip);

  if (!ipaddr.isValid(normalized)) {
    return true;
  }

  return isBlockedAddr(ipaddr.process(normalized));
}

function normalizeIp(ip: string): string {
  return ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function isBlockedAddr(addr: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (addr instanceof ipaddr.IPv6 && addr.range() === '6to4') {
    const parts = addr.toByteArray();

    if (parts.length < 16) {
      return true;
    }

    return isBlockedAddr(ipaddr.IPv4.parse(`${parts[2]}.${parts[3]}.${parts[4]}.${parts[5]}`));
  }

  if (addr instanceof ipaddr.IPv6 && addr.range() === 'teredo') {
    const parts = addr.toByteArray();

    if (parts.length < 16) {
      return true;
    }

    return isBlockedAddr(ipaddr.IPv4.parse(`${parts[12]}.${parts[13]}.${parts[14]}.${parts[15]}`));
  }

  // Deprecated IPv4-compatible IPv6 (::/96). Dotted form (::192.168.0.1) is
  // already process()'d to IPv4; hex form (::c0a8:1) stays IPv6 unicast.

  if (addr instanceof ipaddr.IPv6 && addr.range() === 'unicast') {
    const parts = addr.toByteArray();

    if (parts.length >= 16 && parts.slice(0, 12).every((byte) => byte === 0)) {
      return isBlockedAddr(
        ipaddr.IPv4.parse(`${parts[12]}.${parts[13]}.${parts[14]}.${parts[15]}`),
      );
    }
  }

  return BLOCKED_IP_RANGES.has(addr.range());
}
