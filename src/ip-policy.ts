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

/** True for localhost, .local, .internal. Empty input fails closed. */
export function isBlockedHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();

  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }

  if (!host) {
    return true;
  }

  return host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal');
}

/** True when the address must not be fetched. Invalid input fails closed. */
export function isBlockedIpString(ip: string): boolean {
  const normalized = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!ipaddr.isValid(normalized)) {
    return true;
  }

  return isBlockedAddr(ipaddr.process(normalized));
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
