import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAutoActivation,
  matchesAnySite,
  matchesSite,
  normalizeSettings,
  normalizeSitePattern,
  parseSiteList
} from '../proxy-timezone-extension/core.js';

test('site patterns normalize bare hosts, wildcards, schemes and paths', () => {
  assert.equal(normalizeSitePattern('chatgpt.com'), '*://chatgpt.com/*');
  assert.equal(normalizeSitePattern(' *.openai.com '), '*://*.openai.com/*');
  assert.equal(normalizeSitePattern('https://claude.ai/chat/*'), 'https://claude.ai/chat/*');
  assert.equal(normalizeSitePattern('//example.com/path'), '*://example.com/path');
  assert.equal(normalizeSitePattern('http://127.0.0.1:8080/*'), 'http://127.0.0.1:8080/*');
  for (const value of ['', '*', 'foo*bar.com', 'https://user@example.com/*', 'example.com/#hash', 'ftp://example.com/*']) {
    assert.throws(() => normalizeSitePattern(value), undefined, value);
  }
});

test('site matching is host-aware and treats a leading wildcard as domain plus subdomains', () => {
  assert.equal(matchesSite('chatgpt.com', 'https://chatgpt.com/'), true);
  assert.equal(matchesSite('chatgpt.com', 'https://www.chatgpt.com/'), false);
  assert.equal(matchesSite('*.chatgpt.com', 'https://chatgpt.com/'), true);
  assert.equal(matchesSite('*.chatgpt.com', 'https://chatgpt.com.evil.example/'), false);
  assert.equal(matchesSite('*.chatgpt.com', 'https://a.b.chatgpt.com/'), true);
  assert.equal(matchesSite('https://chatgpt.com/chat/*', 'https://chatgpt.com/chat/abc?x=1'), true);
  assert.equal(matchesSite('https://chatgpt.com/chat/*', 'https://chatgpt.com/other'), false);
  assert.equal(matchesSite('http://127.0.0.1:8080/*', 'http://127.0.0.1:8080/probe'), true);
  assert.equal(matchesSite('http://127.0.0.1:8080/*', 'http://127.0.0.1:9090/probe'), false);
  assert.equal(matchesSite('*.example.com', 'chrome://example.com/'), false);
  assert.equal(matchesAnySite(['*.openai.com', 'chatgpt.com'], 'https://chatgpt.com/'), true);
});

test('site lists ignore comments, deduplicate and report bad lines in strict mode', () => {
  assert.deepEqual(
    parseSiteList('# target sites\nchatgpt.com\n\n*.openai.com\nchatgpt.com'),
    ['*://chatgpt.com/*', '*://*.openai.com/*']
  );
  assert.deepEqual(parseSiteList(['chatgpt.com', 'bad host'], { strict: false }), ['*://chatgpt.com/*']);
  assert.throws(() => parseSiteList(['chatgpt.com', 'bad host'], { strict: true }), /第 2 行/);
});

test('stored settings migrate to safe defaults and sanitize site rules', () => {
  const defaults = normalizeSettings();
  assert.equal(defaults.activation, 'manual');
  assert.deepEqual(defaults.sites, []);
  assert.equal(defaults.autoReload, true);
  assert.equal(defaults.restoreOnLeave, true);
  assert.equal(defaults.skipWhenLocal, true);

  const migrated = normalizeSettings({
    activation: 'sites',
    sites: ['chatgpt.com', 'bad host'],
    autoReload: false,
    restoreOnLeave: false,
    skipWhenLocal: false,
    unknown: true
  });
  assert.equal(migrated.activation, 'sites');
  assert.deepEqual(migrated.sites, ['*://chatgpt.com/*']);
  assert.equal(migrated.autoReload, false);
  assert.equal(migrated.restoreOnLeave, false);
  assert.equal(migrated.skipWhenLocal, false);
  assert.equal('unknown' in migrated, false);

  assert.equal(normalizeSettings({ activation: 'bogus' }).activation, 'manual');
});

test('adaptive decision requires a matching site, an exit timezone and a real difference', () => {
  const base = {
    mode: 'sites',
    sites: ['*.chatgpt.com'],
    url: 'https://chatgpt.com/',
    detectedTimezone: 'America/Los_Angeles',
    systemTimezone: 'Asia/Shanghai'
  };
  assert.deepEqual(decideAutoActivation(base), { activate: true, reason: 'active' });
  assert.equal(decideAutoActivation({ ...base, mode: 'manual' }).reason, 'manual');
  assert.equal(decideAutoActivation({ ...base, url: 'https://example.com/' }).reason, 'site-mismatch');
  assert.equal(decideAutoActivation({ ...base, url: 'chrome://settings/' }).reason, 'not-http');
  assert.equal(decideAutoActivation({ ...base, detectedTimezone: 'Asia/Shanghai' }).reason, 'same-as-system');
  assert.equal(
    decideAutoActivation({ ...base, detectedTimezone: 'Asia/Shanghai', skipWhenLocal: false }).activate,
    true
  );
  assert.equal(decideAutoActivation({ ...base, mode: 'all', detectedTimezone: '' }).reason, 'no-timezone');
});
