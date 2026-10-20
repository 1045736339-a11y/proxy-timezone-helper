import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run with Node 24+. BROWSER_PATH can select a Chromium executable.
// This test uses the extension's ordinary popup messages, without test hooks.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'proxy-timezone-extension');
const WORK = path.join(ROOT, '.tmp', 'browser-smoke');
const REPORT = path.join(ROOT, 'test-artifacts', 'browser-smoke-report.json');
const TIMEZONE = 'America/New_York';
const manifest = JSON.parse(await readFile(path.join(EXTENSION, 'manifest.json'), 'utf8'));
const popupPath = manifest.action?.default_popup || manifest.browser_action?.default_popup;
assert(popupPath, 'manifest.action.default_popup is required to exercise the normal UI protocol');
await mkdir(WORK, { recursive: true });
await mkdir(path.dirname(REPORT), { recursive: true });

const report = { startedAt: new Date().toISOString(), attempts: [], checks: [], browser: null };
let browser;
let popup;
let page;
let server;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) { lastError = error; }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error(`CDP disconnected during ${request.method}`));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timed out during ${method}`));
      }, 15000);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

function snapshot() {
  const fixed = new Date('2024-01-15T12:34:56.789Z');
  const explicit = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return {
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    januaryOffset: new Date('2024-01-15T12:00:00Z').getTimezoneOffset(),
    julyOffset: new Date('2024-07-15T12:00:00Z').getTimezoneOffset(),
    localHours: fixed.getHours(),
    localString: fixed.toString(),
    localConstructor: new Date(2024, 0, 15, 12, 34, 56).toISOString(),
    localParse: new Date('2024-01-15T12:34:56').toISOString(),
    dateOnlyParse: new Date('2024-01-15').toISOString(),
    springGap: new Date(2024, 2, 10, 2, 30).toISOString(),
    autumnOverlap: new Date(2024, 10, 3, 1, 30).toISOString(),
    epoch: fixed.getTime(), utcHour: fixed.getUTCHours(), iso: fixed.toISOString(),
    explicitZone: explicit.resolvedOptions().timeZone,
    explicitUTC: explicit.format(fixed),
    now: Date.now(),
  };
}

const snapshotSource = `(${snapshot.toString()})()`;
async function makeServer() {
  server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (route === '/worker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(`postMessage(${snapshotSource});`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const nonce = randomUUID();
    if (route === '/frame') {
      res.end(`<!doctype html><script>parent.postMessage({type:'tz-frame',value:{...${snapshotSource},sourceOrigin:location.origin}},'*');</script>`);
      return;
    }
    // The first page script records values before any asynchronous application code.
    res.end(`<!doctype html><script>
globalThis.firstSnapshot = ${snapshotSource};
globalThis.probeNonce = ${JSON.stringify(nonce)};
globalThis.frameSnapshots = [];
globalThis.workerSnapshot = null;
addEventListener('message', e => { if(e.data?.type === 'tz-frame') frameSnapshots.push(e.data.value); });
new Worker('/worker.js').onmessage = e => { workerSnapshot = e.data; };
</script><title>Timezone browser smoke test</title>
<iframe src="/frame"></iframe><iframe src="http://localhost:${server.address().port}/frame"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function browserCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = process.env.BROWSER_PATH ? [process.env.BROWSER_PATH] : [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  return [...new Set(candidates)].filter(value => value && existsSync(value));
}

async function stopBrowser(instance) {
  if (!instance) return;
  try {
    const connection = await CDP.connect(instance.browserSocket);
    await connection.send('Browser.close').catch(() => {});
    connection.close();
  } catch { instance.process.kill(); }
  await Promise.race([
    new Promise(resolve => instance.process.once('exit', resolve)), sleep(2000),
  ]);
  if (instance.process.exitCode === null) instance.process.kill();
  // This path was created by this test. Check it stays inside the test workspace.
  const relative = path.relative(WORK, instance.profile);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(instance.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
}

async function launch(executable, unsafe = false) {
  const profile = path.join(WORK, `profile-${randomUUID()}`);
  await mkdir(profile, { recursive: true });
  let logs = '';
  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox',
    '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-search-engine-choice-screen',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--load-extension=${EXTENSION}`, `--disable-extensions-except=${EXTENSION}`,
    ...(unsafe ? ['--enable-unsafe-extension-debugging'] : []), 'about:blank',
  ];
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs = (logs + data).slice(-12000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const attempt = { executable, unsafe, disposableProfileSandboxDisabled: true, extensionLoaded: false };
  console.log('ATTEMPT ' + path.basename(executable) + (unsafe ? ' unsafe-extension-debugging' : '')); 
  report.attempts.push(attempt);
  let instance = { process: child, profile, browserSocket: null };
  try {
    const portText = await until(async () => {
      if (spawnError) throw spawnError;
      return readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null);
    }, 'DevToolsActivePort', 15000);
    const [port, browserPath] = portText.trim().split(/\r?\n/);
    instance.base = `http://127.0.0.1:${Number(port)}`;
    instance.browserSocket = `ws://127.0.0.1:${Number(port)}${browserPath}`;
    const target = await until(async () => {
      const targets = await fetch(`${instance.base}/json/list`).then(r => r.json());
      for (const item of targets.filter(item => item.type === 'service_worker' && item.url.startsWith('chrome-extension://'))) {
        const worker = await CDP.connect(item.webSocketDebuggerUrl);
        try {
          const name = await worker.evaluate('chrome.runtime.getManifest().name');
          if (name === manifest.name) return item;
          attempt.otherExtension = { name, url: item.url };
        } finally { worker.close(); }
      }
      return null;
    }, 'extension service worker', 8000);
    instance.extensionId = new URL(target.url).host;
    if (manifest.key) {
      const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
      const manifestId = digest.replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
      assert.equal(instance.extensionId, manifestId, 'loaded extension ID matches manifest public key');
    }
    attempt.extensionLoaded = true;
    instance.version = await fetch(`${instance.base}/json/version`).then(r => r.json());
    attempt.version = instance.version.Browser;
    return instance;
  } catch (error) {
    attempt.error = error.message;
    attempt.logs = logs;
    await stopBrowser(instance);
    return null;
  }
}

async function connectTarget(url) {
  const target = await fetch(`${browser.base}/json/new?${url}`, { method: 'PUT' }).then(r => r.json());
  const connection = await CDP.connect(target.webSocketDebuggerUrl);
  await connection.send('Runtime.enable');
  connection.target = target;
  return connection;
}

async function message(value) {
  const response = await popup.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(value)})`);
  if (response?.ok === false || response?.success === false || response?.error) {
    throw new Error(`Extension ${value.type} failed: ${JSON.stringify(response)}`);
  }
  return response;
}

async function check(name, fn) {
  try {
    const details = await fn();
    report.checks.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
    console.log(`PASS ${name}`);
    return details;
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
    return undefined;
  }
}

function expectNewYork(value) {
  assert.equal(value.zone, TIMEZONE);
  assert.equal(value.januaryOffset, 300);
  assert.equal(value.julyOffset, 240);
  assert.equal(value.localHours, 7);
  assert.match(value.localString, /GMT-0500/);
  assert.equal(value.localConstructor, '2024-01-15T17:34:56.000Z');
  assert.equal(value.localParse, '2024-01-15T17:34:56.000Z');
  assert.equal(value.dateOnlyParse, '2024-01-15T00:00:00.000Z');
  assert.equal(value.springGap, '2024-03-10T07:30:00.000Z');
  assert.equal(value.autumnOverlap, '2024-11-03T05:30:00.000Z');
  assert.equal(value.iso, '2024-01-15T12:34:56.789Z');
  assert.equal(value.epoch, 1705322096789);
  assert.equal(value.utcHour, 12);
  assert.equal(value.explicitZone, 'UTC');
  assert.equal(value.explicitUTC, '15/01/2024, 12:34:56');
  assert(Math.abs(value.now - Date.now()) < 20000, 'Date.now still represents the actual instant');
}

try {
  const base = await makeServer();
  const candidates = browserCandidates();
  assert(candidates.length, 'No Chromium browser found. Set BROWSER_PATH.');
  for (const candidate of candidates) {
    browser = await launch(candidate);
    if (browser) break;
  }
  if (!browser) {
    for (const candidate of candidates) {
      browser = await launch(candidate, true);
      if (browser) break;
    }
  }
  assert(browser, 'Browser extension could not be loaded. See report.attempts for Chrome/Edge restrictions.');
  report.browser = { name: browser.version.Browser, extensionId: browser.extensionId };
  console.log(`BROWSER ${browser.version.Browser}`);
  popup = await connectTarget(`chrome-extension://${browser.extensionId}/${popupPath}`);
  await until(() => popup.evaluate('Boolean(globalThis.chrome?.runtime?.id)'), 'extension popup context');
  try {
    await popup.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 760, deviceScaleFactor: 1, mobile: false });
    const popupImage = await popup.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(path.join(WORK, 'popup.png'), Buffer.from(popupImage.data, 'base64'));
    report.popupScreenshot = path.join(WORK, 'popup.png');
  } catch (error) { report.popupScreenshotError = error.message; }
  page = await connectTarget(`${base}/probe`);
  const baseline = await until(() => page.evaluate('globalThis.firstSnapshot'), 'baseline probe');
  const initialNonce = await page.evaluate('probeNonce');
  const tabId = await until(async () => popup.evaluate(
    `(async()=>{const targets=await chrome.debugger.getTargets();return targets.find(t=>t.url===${JSON.stringify(`${base}/probe`)})?.tabId})()`
  ), 'test tab ID');
  report.baseline = baseline;
  report.tabId = tabId;
  const pageTarget = page.target;
  await new Promise(resolve => {
    page.socket.addEventListener('close', resolve, { once: true });
    page.close();
  });
  page = {
    send(method, params = {}) {
      return popup.evaluate('chrome.debugger.sendCommand(' + JSON.stringify({ tabId }) + ',' + JSON.stringify(method) + ',' + JSON.stringify(params) + ')');
    },
    evaluate: CDP.prototype.evaluate,
    close() {},
  };

  await check('apply through normal popup protocol', async () => {
    const response = await message({ type: 'APPLY', tabId, timezone: TIMEZONE, refresh: true });
    assert(response !== undefined, 'APPLY returned a response');
    await until(() => page.evaluate(`globalThis.probeNonce && probeNonce !== ${JSON.stringify(initialNonce)}`), 'APPLY-triggered refresh');
    return response;
  });
  await check('first inline script, Date, Intl, winter/summer, DST and unchanged UTC', async () => {
    const value = await until(() => page.evaluate('globalThis.firstSnapshot'), 'first inline snapshot');
    expectNewYork(value);
    return value;
  });
  await check('status through normal popup protocol', async () => {
    const response = await message({ type: 'STATUS', tabId });
    assert.equal(response.actual?.timezone, TIMEZONE);
    assert.equal(response.tab?.error, null);
    return response;
  });
  await check('same-origin and cross-origin iframe first scripts', async () => {
    const values = await until(async () => {
      const value = await page.evaluate('frameSnapshots');
      return value?.length >= 2 && value;
    }, 'both iframe snapshots');
    report.iframeSnapshots = values;
    for (const value of values) expectNewYork(value);
    return values;
  });
  await check('dedicated worker', async () => {
    const value = await until(() => page.evaluate('workerSnapshot'), 'worker snapshot');
    expectNewYork(value);
    return value;
  });
  await check('manual refresh retains first-script timezone', async () => {
    const previous = await page.evaluate('probeNonce');
    await page.send('Page.reload');
    await until(() => page.evaluate(`globalThis.probeNonce && probeNonce !== ${JSON.stringify(previous)}`), 'manual reload');
    expectNewYork(await page.evaluate('firstSnapshot'));
  });
  await check('cross-site navigation retains first-script timezone', async () => {
    const url = `http://localhost:${server.address().port}/probe`;
    await page.send('Page.navigate', { url });
    const value = await until(async () => {
      const result = await page.evaluate(`location.href === ${JSON.stringify(url)} && globalThis.firstSnapshot`);
      return result || null;
    }, 'cross-site first-script snapshot');
    expectNewYork(value);
    return value;
  });
  await check('stop and refresh restore baseline browser timezone', async () => {
    const previous = await page.evaluate('probeNonce');
    const response = await message({ type: 'STOP', tabId });
    page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Page.reload');
    await until(() => page.evaluate(`globalThis.probeNonce && probeNonce !== ${JSON.stringify(previous)}`), 'stop reload');
    const value = await page.evaluate('firstSnapshot');
    assert.equal(value.zone, baseline.zone);
    assert.equal(value.januaryOffset, baseline.januaryOffset);
    assert.equal(value.julyOffset, baseline.julyOffset);
    return { response, snapshot: value };
  });
  await check('related same-origin tabs retain timezone when first owner stops and remaining tab changes zone', async () => {
    await new Promise(resolve => {
      page.socket.addEventListener('close', resolve, { once: true });
      page.close();
    });
    const nativePage = id => ({
      send(method, params = {}) {
        return popup.evaluate('chrome.debugger.sendCommand(' + JSON.stringify({ tabId: id }) + ',' + JSON.stringify(method) + ',' + JSON.stringify(params) + ')');
      },
      evaluate: CDP.prototype.evaluate,
      close() {},
    });
    page = nativePage(tabId);
    await message({ type: 'APPLY', tabId, timezone: TIMEZONE, refresh: true });
    const url = 'http://localhost:' + server.address().port + '/probe';
    const second = await popup.evaluate('chrome.tabs.create(' + JSON.stringify({ url, openerTabId: tabId, active: false }) + ')');
    const secondPage = nativePage(second.id);
    const observations = {};
    try {
      await message({ type: 'APPLY', tabId: second.id, timezone: TIMEZONE, refresh: true });
      await until(async () => secondPage.evaluate('globalThis.firstSnapshot?.zone === ' + JSON.stringify(TIMEZONE)), 'second tab initial timezone');
      observations.bothEnabled = await secondPage.evaluate(snapshotSource);
      expectNewYork(observations.bothEnabled);
      await message({ type: 'STOP', tabId });
      observations.afterFirstStops = await secondPage.evaluate(snapshotSource);
      expectNewYork(observations.afterFirstStops);
      let nonce = await secondPage.evaluate('probeNonce');
      await message({ type: 'APPLY', tabId: second.id, timezone: 'Asia/Tokyo', refresh: true });
      await until(() => secondPage.evaluate('globalThis.probeNonce && probeNonce !== ' + JSON.stringify(nonce)), 'second tab Tokyo reload');
      observations.changed = await secondPage.evaluate(snapshotSource);
      assert.equal(observations.changed.zone, 'Asia/Tokyo');
      assert.equal(observations.changed.januaryOffset, -540);
      assert.equal(observations.changed.julyOffset, -540);
      nonce = await secondPage.evaluate('probeNonce');
      await message({ type: 'APPLY', tabId: second.id, timezone: TIMEZONE, refresh: true });
      await until(() => secondPage.evaluate('globalThis.probeNonce && probeNonce !== ' + JSON.stringify(nonce)), 'second tab New York reload');
      observations.returned = await secondPage.evaluate(snapshotSource);
      expectNewYork(observations.returned);
      return observations;
    } finally {
      await message({ type: 'STOP', tabId: second.id }).catch(() => {});
      await popup.evaluate('chrome.tabs.remove(' + JSON.stringify(second.id) + ')').catch(() => {});
      report.relatedTabs = observations;
    }
  });
} catch (error) {
  report.popupContext = await popup?.evaluate('({href:location.href, title:document.title, text:document.body?.innerText.slice(0,500), runtimeId:globalThis.chrome?.runtime?.id})').catch(() => null);
  report.error = error.stack || error.message;
  console.error(error.message);
} finally {
  page?.close();
  popup?.close();
  await stopBrowser(browser);
  if (server) await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  report.passed = !report.error && report.checks.length > 0 && report.checks.every(item => item.passed);
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`REPORT ${REPORT}`);
  process.exitCode = report.passed ? 0 : 1;
}
