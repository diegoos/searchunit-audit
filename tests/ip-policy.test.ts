import { describe, expect, test } from 'bun:test';
import {
  isBlockedHostname,
  isBlockedIpString,
  isLoopbackHostname,
  isLoopbackIpString,
} from '../src/ip-policy.ts';

describe('isBlockedHostname', () => {
  test.each([
    'localhost',
    'printer.local',
    'api.internal',
    'metadata.google.internal',
    'LocalHost.',
    '[localhost]',
    '',
    '   ',
  ])('blocks %j', (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });
  test('allows a public hostname', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
  });
});

describe('loopback names and addresses', () => {
  test.each([
    ['localhost', true],
    ['LocalHost.', true],
    ['app.localhost', true],
    ['printer.local', false],
    ['example.com', false],
  ])('isLoopbackHostname(%j) is %s', (host, expected) => {
    expect(isLoopbackHostname(host)).toBe(expected);
  });
  test.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    ['10.0.0.1', false],
    ['8.8.8.8', false],
    ['not-an-ip', false],
  ])('isLoopbackIpString(%j) is %s', (ip, expected) => {
    expect(isLoopbackIpString(ip)).toBe(expected);
  });
});

describe('isBlockedIpString', () => {
  test.each([
    '127.0.0.1',
    '10.0.0.1',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::ffff:0:7f00:1',
    '224.0.0.1',
    'ff02::1',
    'fec0::1',
    '::c0a8:1',
    '::a00:1',
    '64:ff9b::8.8.8.8',
    '2002:7f00:1::',
    '2001:0:53aa:64c:0:5efe:c0a8:101',
    'not-an-ip',
    '',
  ])('blocks %j', (ip) => {
    expect(isBlockedIpString(ip)).toBe(true);
  });
  test.each(['8.8.8.8', '::ffff:8.8.8.8', '2002:808:808::'])('allows public %j', (ip) => {
    expect(isBlockedIpString(ip)).toBe(false);
  });
});
