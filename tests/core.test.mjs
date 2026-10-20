import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimezone, normalizeDetection, lookupExit, LOOKUP_URL } from '../proxy-timezone-extension/core.js';

const fixture = { success: true, ip: '203.0.113.7', city: 'Los Angeles', region: 'California', country: 'United States', timezone: { id: 'America/Los_Angeles' } };

test('IP timezone is authoritative and retains a city timezone with DST', () => {
  const result = normalizeDetection(fixture, 123);
  assert.equal(result.timezone, 'America/Los_Angeles');
  assert.equal(result.ip, fixture.ip);
  assert.equal(result.checkedAt, 123);
  const fmt = new Intl.DateTimeFormat('en', { timeZone: result.timezone, hour: 'numeric', hourCycle: 'h23' });
  assert.equal(fmt.format(new Date('2026-01-15T12:00:00Z')), '04');
  assert.equal(fmt.format(new Date('2026-07-15T12:00:00Z')), '05');
});

test('incomplete and unsuccessful geolocation responses are rejected', () => {
  for (const data of [null, {}, { success: false, message: 'rate limited' }, { ...fixture, ip: '' }, { ...fixture, timezone: {} }]) {
    assert.throws(() => normalizeDetection(data));
  }
});

test('manual values reject invalid names and fixed offsets', () => {
  assert.equal(normalizeTimezone(' Asia/Singapore '), 'Asia/Singapore');
  assert.equal(normalizeTimezone('UTC'), 'UTC');
  for (const zone of ['', 'US Eastern Somewhere', '+08:00', '-08:00', undefined]) assert.throws(() => normalizeTimezone(zone));
});

test('IPv6 output is accepted', () => {
  assert.equal(normalizeDetection({ ...fixture, ip: '2001:db8::5' }).ip, '2001:db8::5');
});

test('lookup uses only the named HTTPS endpoint, omits cookies and caching', async () => {
  let request;
  const result = await lookupExit(async (url, options) => {
    request = { url, options };
    return { ok: true, text: async () => JSON.stringify(fixture) };
  });
  assert.equal(request.url, LOOKUP_URL);
  assert.equal(new URL(request.url).origin, 'https://ipwho.is');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.redirect, 'error');
  assert.equal(result.timezone, fixture.timezone.id);
});

test('network, rate limit, oversized and malformed failures never produce a fallback timezone', async () => {
  const cases = [
    async () => { throw new TypeError('offline'); },
    async () => ({ ok: false, status: 429 }),
    async () => ({ ok: true, text: async () => '<html>blocked</html>' }),
    async () => ({ ok: true, text: async () => 'x'.repeat(32769) }),
    async () => ({ ok: true, text: async () => JSON.stringify({ success: false }) })
  ];
  for (const fetcher of cases) await assert.rejects(() => lookupExit(fetcher));
});
