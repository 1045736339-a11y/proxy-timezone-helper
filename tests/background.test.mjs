import test from 'node:test';
import assert from 'node:assert/strict';

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, fire(...args) { for (const fn of listeners) fn(...args); }, listeners };
}

function mockChrome() {
  const local = {};
  const session = {};
  const attached = new Set();
  const tabUrls = new Map([
    [1, 'https://test.example/'],
    [2, 'https://test.example/'],
    [3, 'https://test.example/']
  ]);
  let reloads = 0;
  const processes = new Map([[1, { zone: 'Asia/Shanghai', owner: null }], [2, { zone: 'Asia/Shanghai', owner: null }]]);
  const processFor = id => processes.get(id === 3 ? 2 : 1);
  const idFor = target => String(target.tabId) + ':' + (target.sessionId || 'root');
  const area = data => ({
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    async set(values) { Object.assign(data, structuredClone(values)); }
  });
  let failure = null;
  const chrome = {
    runtime: { id: 'test-extension', onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: area(local), session: area(session) },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    tabs: {
      onRemoved: event(), onUpdated: event(), onActivated: event(),
      async get(tabId) {
        if (!tabUrls.has(tabId)) throw new Error('No tab with id ' + tabId);
        return { id: tabId, url: tabUrls.get(tabId), discarded: false };
      },
      async query() { return [...tabUrls].map(([id, url]) => ({ id, url, discarded: false })); }
    },
    webNavigation: {
      onBeforeNavigate: event(), onCommitted: event(), onHistoryStateUpdated: event()
    },
    alarms: { onAlarm: event(), async create() {}, async clear() {} },
    debugger: {
      onDetach: event(), onEvent: event(),
      async getTargets() { return [...tabUrls].map(([tabId, url]) => ({ tabId, type: 'page', url, attached: attached.has(tabId) })); },
      async attach({ tabId }) { if (attached.has(tabId)) throw new Error('already attached'); attached.add(tabId); },
      async detach(target) {
        attached.delete(target.tabId);
        const state = processFor(target.tabId);
        if (state.owner === idFor(target)) { state.owner = null; state.zone = 'Asia/Shanghai'; }
        queueMicrotask(() => chrome.debugger.onDetach.fire(target, 'canceled_by_user'));
      },
      async sendCommand(target, method, params = {}) {
        if (!attached.has(target.tabId)) throw new Error('not attached');
        const state = processFor(target.tabId);
        if (method === 'Emulation.setTimezoneOverride') {
          if (failure?.tabId === target.tabId && failure.timezone === params.timezoneId) {
            failure = null;
            throw new Error('simulated transient apply failure');
          }
          if (params.timezoneId === '') {
            if (state.owner === idFor(target)) { state.owner = null; state.zone = 'Asia/Shanghai'; }
          } else if (state.owner && state.owner !== idFor(target) && state.zone !== params.timezoneId) {
            throw new Error('Timezone override is already in effect');
          } else {
            state.zone = params.timezoneId;
            state.owner ||= idFor(target);
          }
          return {};
        }
        if (method === 'Runtime.evaluate') return { result: { value: { timezone: state.zone, offset: 0, winterOffset: 0, summerOffset: 0, date: 'test' } } };
        if (method === 'Page.reload') {
          reloads++;
          queueMicrotask(() => chrome.debugger.onEvent.fire(target, 'Page.frameNavigated', { frame: { id: 'main' } }));
        }
        return {};
      }
    }
  };
  return {
    chrome, local, session, processFor, tabUrls,
    failNext(tabId, timezone) { failure = { tabId, timezone }; },
    get reloads() { return reloads; },
    navigate(tabId, url) {
      tabUrls.set(tabId, url);
      chrome.webNavigation.onBeforeNavigate.fire({ tabId, frameId: 0, url });
      chrome.webNavigation.onCommitted.fire({ tabId, frameId: 0, url });
    },
    message(payload) {
      return new Promise(resolve => {
        const keep = chrome.runtime.onMessage.listeners[0](payload, { id: chrome.runtime.id }, resolve);
        assert.equal(keep, true);
      });
    }
  };
}

test('managed tabs survive shared renderer owner removal, global changes, rollback and retry', async () => {
  const env = mockChrome();
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let apiZone = 'America/New_York';
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ success: true, ip: '203.0.113.8', city: 'Test', timezone: { id: apiZone } }) });
  try {
    await import('../proxy-timezone-extension/background.js?mock=' + Date.now());
    const send = async message => {
      const result = await env.message(message);
      assert.equal(result.ok, true, result.error);
      return result;
    };
    await send({ type: 'APPLY', tabId: 1, timezone: 'America/New_York' });
    await send({ type: 'APPLY', tabId: 2, timezone: 'America/New_York' });
    assert.equal(env.processFor(1).owner, '1:root');
    await send({ type: 'STOP', tabId: 1 });
    let status = await send({ type: 'STATUS', tabId: 2 });
    assert.equal(status.actual.timezone, 'America/New_York', 'the remaining tab must retain its timezone when the renderer owner is removed');
    assert.equal(status.tab.error, null);
    await send({ type: 'APPLY', tabId: 1, timezone: 'America/New_York' });
    await send({ type: 'APPLY', tabId: 1, timezone: 'America/Los_Angeles' });
    assert.equal(env.processFor(1).zone, 'America/Los_Angeles', 'a non-owner tab can initiate a global timezone change');
    status = await send({ type: 'STATUS', tabId: 2 });
    assert.equal(status.tab.timezone, 'America/Los_Angeles');
    env.failNext(1, 'America/New_York');
    const failed = await env.message({ type: 'APPLY', tabId: 1, timezone: 'America/New_York' });
    assert.equal(failed.ok, false, 'a failed switch is returned to the caller');
    status = await send({ type: 'STATUS', tabId: 2 });
    assert.equal(status.actual.timezone, 'America/Los_Angeles', 'the previous working timezone is restored after a switch failure');
    assert.equal(status.settings.timezone, 'America/Los_Angeles');
    await send({ type: 'APPLY', tabId: 3, timezone: 'America/Los_Angeles' });
    await send({ type: 'SET_AUTO', enabled: true });
    apiZone = 'America/New_York';
    env.failNext(3, apiZone);
    env.chrome.alarms.onAlarm.fire({ name: 'proxy-timezone-sync' });
    await send({ type: 'STATUS', tabId: 3 });
    env.chrome.alarms.onAlarm.fire({ name: 'proxy-timezone-sync' });
    status = await send({ type: 'STATUS', tabId: 3 });
    assert.equal(status.actual.timezone, apiZone, 'a later synchronization retries failed updates');
    assert.equal(status.tab.error, null);
    await send({ type: 'STOP', tabId: 1 });
    await send({ type: 'STOP', tabId: 2 });
    await send({ type: 'STOP', tabId: 3 });
    assert.equal(env.processFor(1).zone, 'Asia/Shanghai');
    assert.equal(env.processFor(3).zone, 'Asia/Shanghai');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

function autoSettings(overrides = {}) {
  return {
    activation: 'sites',
    sites: ['*://test.example/*'],
    autoReload: false,
    restoreOnLeave: true,
    skipWhenLocal: false,
    detection: {
      ip: '203.0.113.8', country: 'Test', region: 'Test', city: 'Test',
      timezone: 'America/New_York', checkedAt: Date.now(), provider: 'ipwho.is'
    },
    ...overrides
  };
}

test('auto mode applies only to matching sites and restores when leaving', async () => {
  const env = mockChrome();
  env.local.settings = autoSettings();
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => { throw new Error('cached detection should avoid a lookup'); };
  try {
    await import('../proxy-timezone-extension/background.js?auto-sites=' + Date.now());
    env.navigate(1, 'https://test.example/chat');
    let status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.ok, true, status.error);
    assert.equal(env.processFor(1).zone, 'America/New_York');
    assert.equal(status.tab.auto, true, 'the tab is marked as auto-managed');
    assert.equal(status.auto.matched, true);
    assert.equal(env.reloads, 0, 'auto reload is disabled in these settings');

    env.navigate(1, 'https://outside.example/');
    status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.ok, true, status.error);
    assert.equal(status.tab, null, 'leaving the allowlist restores the tab');
    assert.equal(env.processFor(1).zone, 'Asia/Shanghai');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test('auto mode skips activation when the exit timezone equals the system timezone', async () => {
  const env = mockChrome();
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  env.local.settings = autoSettings({
    skipWhenLocal: true,
    detection: {
      ip: '203.0.113.8', country: 'Test', region: 'Test', city: 'Test',
      timezone: systemZone, checkedAt: Date.now(), provider: 'ipwho.is'
    }
  });
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => { throw new Error('cached detection should avoid a lookup'); };
  try {
    await import('../proxy-timezone-extension/background.js?auto-local=' + Date.now());
    env.navigate(1, 'https://test.example/chat');
    const status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.ok, true, status.error);
    assert.equal(status.tab, null, 'the tab stays unmanaged');
    assert.equal(env.processFor(1).zone, 'Asia/Shanghai');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test('an early navigation failure is retried after commit instead of being suppressed', async () => {
  const env = mockChrome();
  env.local.settings = autoSettings();
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => { throw new Error('cached detection should avoid a lookup'); };
  try {
    await import('../proxy-timezone-extension/background.js?auto-early=' + Date.now());
    env.failNext(1, 'America/New_York');
    env.navigate(1, 'https://test.example/chat');
    const status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.ok, true, status.error);
    assert.equal(status.tab?.auto, true);
    assert.equal(env.processFor(1).zone, 'America/New_York');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test('a manual apply overrides the auto rule for the same URL, then yields on navigation', async () => {
  const env = mockChrome();
  env.local.settings = autoSettings();
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => { throw new Error('cached detection should avoid a lookup'); };
  try {
    await import('../proxy-timezone-extension/background.js?auto-manual=' + Date.now());
    env.navigate(1, 'https://test.example/chat');
    let status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.tab?.auto, true);

    status = await env.message({ type: 'APPLY', tabId: 1, timezone: 'Asia/Tokyo' });
    assert.equal(status.ok, true, status.error);
    status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.actual.timezone, 'Asia/Tokyo');

    env.navigate(1, 'https://test.example/chat');
    status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.actual.timezone, 'Asia/Tokyo', 'the same URL keeps the manual override');
    assert.equal(status.tab.manual, true);

    env.navigate(1, 'https://test.example/other');
    status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.actual.timezone, 'America/New_York', 'a new URL lets the auto rule take over');
    assert.equal(status.tab.auto, true);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test('auto mode reloads once after applying and switching back to manual stops auto tabs', async () => {
  const env = mockChrome();
  env.local.settings = autoSettings({ autoReload: true });
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = env.chrome;
  globalThis.fetch = async () => { throw new Error('cached detection should avoid a lookup'); };
  try {
    await import('../proxy-timezone-extension/background.js?auto-reload=' + Date.now());
    env.navigate(1, 'https://test.example/chat');
    let status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.ok, true, status.error);
    assert.equal(env.reloads, 1, 'first entry reloads once');
    assert.equal(status.tab.auto, true);

    status = await env.message({ type: 'SET_ACTIVATION', activation: 'manual' });
    assert.equal(status.ok, true, status.error);
    status = await env.message({ type: 'STATUS', tabId: 1 });
    assert.equal(status.tab, null, 'switching to manual restores auto-managed tabs');
    assert.equal(env.processFor(1).zone, 'Asia/Shanghai');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
