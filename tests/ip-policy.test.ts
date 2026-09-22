import { describe, expect, test } from 'bun:test';
import { isBlockedHostname, isBlockedIpString } from '../src/ip-policy.ts';

describe('isBlockedHostname', () => {
  test('blocks localhost, .local, and .internal', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('printer.local')).toBe(true);
    expect(isBlockedHostname('api.internal')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
  });
  test('normalizes brackets, trailing dots, and empty input', () => {
    expect(isBlockedHostname('LocalHost.')).toBe(true);
    expect(isBlockedHostname('[localhost]')).toBe(true);
    expect(isBlockedHostname('')).toBe(true);
    expect(isBlockedHostname('   ')).toBe(true);
  });
  test('allows a public hostname', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
  });
});

describe('isBlockedIpString', () => {
  test('blocks loopback, private, mapped, and translation forms; allows public IPv4', () => {
    expect(isBlockedIpString('127.0.0.1')).toBe(true);
    expect(isBlockedIpString('10.0.0.1')).toBe(true);
    expect(isBlockedIpString('::1')).toBe(true);
    expect(isBlockedIpString('[::1]')).toBe(true);
    expect(isBlockedIpString('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpString('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIpString('::ffff:0:7f00:1')).toBe(true);
    expect(isBlockedIpString('8.8.8.8')).toBe(false);
    expect(isBlockedIpString('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIpString('224.0.0.1')).toBe(true);
    expect(isBlockedIpString('ff02::1')).toBe(true);
    expect(isBlockedIpString('fec0::1')).toBe(true);
    expect(isBlockedIpString('::c0a8:1')).toBe(true);
    expect(isBlockedIpString('::a00:1')).toBe(true);
  });
  test('blocks NAT64 and private 6to4; allows public 6to4; fails closed on invalid', () => {
    expect(isBlockedIpString('64:ff9b::8.8.8.8')).toBe(true);
    expect(isBlockedIpString('2002:7f00:1::')).toBe(true);
    expect(isBlockedIpString('2002:808:808::')).toBe(false);
    expect(isBlockedIpString('2001:0:53aa:64c:0:5efe:c0a8:101')).toBe(true);
    expect(isBlockedIpString('not-an-ip')).toBe(true);
    expect(isBlockedIpString('')).toBe(true);
  });
});
