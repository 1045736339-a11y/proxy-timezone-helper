import {
  ACTIVATION_MODES, ALARM_NAME, DEFAULT_SETTINGS, SNAPSHOT_EXPRESSION,
  decideAutoActivation, lookupExit, matchesAnySite, normalizeSettings,
  normalizeTimezone, parseSiteList
} from './core.js';

let settings;
let lookupError = null;
const managed = new Map();
const children = new Map();
// Workers may inherit an override without supporting the Emulation domain.
const overriddenChildren = new WeakSet();
const initializingChildren = new WeakSet();
const pendingReloads = new Set();
// Auto mode must not reload the same tab in a loop when a page keeps
// reporting a stale timezone after navigation.
const autoReloads = new Map();
const autoFailures = new Map();
const DETECTION_MAX_AGE = 10 * 60 * 1000;
const LOOKUP_FAILURE_COOLDOWN = 30 * 1000;
const AUTO_RELOAD_COOLDOWN = 60 * 1000;
const AUTO_FAILURE_COOLDOWN = 30 * 1000;
let queue = Promise.resolve();

const ready = (async () => {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'lookupError']),
    chrome.storage.session.get('managedTabs')
  ]);
  settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...local.settings });
  lookupError = local.lookupError || null;
  for (const [key, value] of Object.entries(session.managedTabs || {})) managed.set(Number(key), value);
})();

function serial(task) {
  const next = queue.then(async () => { await ready; return task(); });
  queue = next.catch(() => {});
  return next;
}

async function persist() {
  await Promise.all([
    chrome.storage.local.set({ settings, lookupError }),
    chrome.storage.session.set({ managedTabs: Object.fromEntries(managed) })
  ]);
}

async function badge(tabId, text, title) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: text === 'TZ' ? '#246557' : '#a45420' });
    await chrome.action.setTitle({ tabId, title });
  } catch { /* The tab may already have closed. */ }
}

function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isAutoMode() {
  return settings.activation === 'sites' || settings.activation === 'all';
}

function autoMatches(url) {
  if (!isAutoMode() || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  return settings.activation === 'all' || matchesAnySite(settings.sites, url);
}

function autoFailureBlocked(tabId, url) {
  const failure = autoFailures.get(tabId);
  return Boolean(failure && failure.url === url && Date.now() - failure.at < AUTO_FAILURE_COOLDOWN);
}

function rememberAutoFailure(tabId, url, message) {
  autoFailures.set(tabId, { url, at: Date.now(), message });
  if (autoFailures.size > 50) {
    const cutoff = Date.now() - AUTO_RELOAD_COOLDOWN;
    for (const [id, failure] of autoFailures) if (failure.at < cutoff) autoFailures.delete(id);
  }
}

function recentlyAutoReloaded(tabId, url) {
  const last = autoReloads.get(tabId);
  return Boolean(last && last.url === url && Date.now() - last.at < AUTO_RELOAD_COOLDOWN);
}

async function ensureDetection(maxAge = DETECTION_MAX_AGE) {
  const cached = settings.detection;
  if (cached && cached.timezone && Date.now() - cached.checkedAt < maxAge) return cached;
  // Avoid one slow/failed lookup per tab during a scan. A manual DETECT still
  // reaches the service directly and can clear the error immediately.
  if (lookupError && Date.now() - (lookupError.at || 0) < LOOKUP_FAILURE_COOLDOWN) {
    throw new Error(lookupError.message || '出口查询刚刚失败，请稍后重试。');
  }
  return detect();
}

async function currentTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || tab?.pendingUrl || null;
  } catch {
    return null;
  }
}

async function snapshot(target) {
  const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: SNAPSHOT_EXPRESSION, returnByValue: true
  });
  if (result.exceptionDetails || !result.result?.value) throw new Error('当前页没有返回可验证的时区信息。');
  return result.result.value;
}

async function setZone(target, timezone) {
  await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: timezone });
  if (target.sessionId) {
    if (timezone) overriddenChildren.add(target);
    else overriddenChildren.delete(target);
  }
}

function isMissingChild(error) {
  return /session.*(?:not found|closed)|no (?:session|target)|target.*(?:not found|closed)|detached/i.test(error.message);
}

async function snapshotChild(target) {
  for (let attempt = 0; ; attempt++) {
    try { return await snapshot(target); }
    catch (error) {
      if (attempt >= 2 || !/execution context|cannot find context/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
}

async function autoAttach(target) {
  await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'iframe', exclude: false }, { type: 'worker', exclude: false }, { exclude: true }]
  });
}

async function warn(tabId, message) {
  const entry = managed.get(tabId);
  if (!entry) return;
  if (!entry.warnings.includes(message)) entry.warnings.push(message);
  entry.warnings = entry.warnings.slice(-8);
  await persist();
  await badge(tabId, '!', '代理时区助手 · 部分内容未确认，请打开扩展查看');
}

// Related frames and dedicated workers can be separate browser targets.
// Always resume a paused target, including when timezone emulation is unavailable.
async function initializeChild(source, params) {
  await ready;
  const target = { tabId: source.tabId, sessionId: params.sessionId };
  const tabId = source.tabId;
  let childMap = children.get(tabId);
  if (!childMap) children.set(tabId, childMap = new Map());
  childMap.set(params.sessionId, target);
  initializingChildren.add(target);
  try {
  let entry;
  let zoneError = null;
  let nestedError = null;
  let resumed = true;
  try {
    entry = managed.get(tabId);
    if (!entry) return;
    // A paused new iframe may have no JS execution context yet. Set its native
    // timezone before first scripts instead of reading Intl before resuming it.
    try { await setZone(target, entry.timezone); }
    catch (error) { zoneError = error; }
    if (params.targetInfo?.type === 'iframe') {
      try { await autoAttach(target); }
      catch (error) { nestedError = error; }
    }
  } finally {
    if (params.waitingForDebugger) {
      try { await chrome.debugger.sendCommand(target, 'Runtime.runIfWaitingForDebugger'); }
      catch (error) {
        resumed = false;
        if (isMissingChild(error)) children.get(tabId)?.delete(params.sessionId);
        else await warn(tabId, '子内容恢复失败。请关闭这个标签后重新打开。' + error.message.slice(0, 100));
      }
    }
  }
  if (!entry || !resumed || !managed.has(tabId)) return;
  try {
    const currentEntry = managed.get(tabId);
    const check = await snapshotChild(target);
    if (normalizeTimezone(check.timezone) !== currentEntry.timezone) {
      throw new Error('子页面或 Worker 时区验证未通过。' + (zoneError ? zoneError.message : ''));
    }
    if (nestedError) await warn(tabId, '子页面递归处理未启用。' + nestedError.message.slice(0, 160));
  } catch (error) {
    if (isMissingChild(error)) children.get(tabId)?.delete(params.sessionId);
    else await warn(tabId, '部分子页面或 Worker 未确认。' + error.message.slice(0, 160));
  }
  } finally { initializingChildren.delete(target); }
}

async function attach(tabId, timezone) {
  if (!Number.isInteger(tabId)) throw new Error('没有找到当前标签页。');
  const known = managed.get(tabId);
  if (known) return known;
  const targets = await chrome.debugger.getTargets();
  const target = targets.find(item => item.tabId === tabId && item.type === 'page');
  if (!target || !/^https?:\/\//i.test(target.url)) throw new Error('请先打开普通网站。浏览器设置页和扩展页面不能应用时区。');
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    throw new Error('无法启用原生时区功能。请关闭该标签的开发者工具，并检查是否有其他调试扩展。' + error.message);
  }
  const entry = { timezone, appliedAt: null, needsReload: true, error: null, warnings: [] };
  managed.set(tabId, entry);
  await persist();
  return entry;
}

async function applyOne(tabId, timezone) {
  const wasManaged = managed.has(tabId);
  const entry = await attach(tabId, timezone);
  entry.timezone = timezone;
  entry.error = null;
  entry.warnings = [];
  entry.needsReload = true;
  try {
    await setZone({ tabId }, timezone);
    const actual = await snapshot({ tabId });
    if (normalizeTimezone(actual.timezone) !== timezone) throw new Error('主页面实测时区与设置不一致。');
    entry.appliedAt = Date.now();
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    try { await autoAttach({ tabId }); }
    catch (error) { entry.warnings.push('子页面自动处理未启用。' + error.message.slice(0, 120)); }
    for (const target of children.get(tabId)?.values() || []) {
      if (initializingChildren.has(target)) continue;
      try {
        const child = await snapshot(target);
        if (normalizeTimezone(child.timezone) !== timezone) await setZone(target, timezone);
        const check = await snapshot(target);
        if (normalizeTimezone(check.timezone) !== timezone) throw new Error('时区与设置不一致');
      } catch (error) { entry.warnings.push('部分已有子内容未更新。' + error.message.slice(0, 120)); }
    }
    await badge(tabId, entry.warnings.length ? '!' : 'TZ', '代理时区助手 · ' + timezone);
    await persist();
    return actual;
  } catch (error) {
    entry.error = error.message;
    if (!wasManaged) {
      // Failed first activation must not leave a debugger attached to the page.
      try { await chrome.debugger.detach({ tabId }); } catch { /* Closed or detached. */ }
      managed.delete(tabId);
      children.delete(tabId);
    }
    await badge(tabId, '!', '代理时区助手 · 应用失败');
    await persist();
    throw error;
  }
}

async function detect() {
  try {
    const detection = await lookupExit();
    settings.detection = detection;
    lookupError = null;
    await persist();
    return detection;
  } catch (error) {
    lookupError = { message: error.message, at: Date.now() };
    await persist();
    throw error;
  }
}

// A timezone override belongs to one agent in a renderer. Other targets may
// share it without owning a handle, so losing its owner needs a fresh check.
async function repairManaged() {
  const failures = [];
  for (const [tabId, entry] of managed) {
    const targets = [{ tabId }, ...(children.get(tabId)?.values() || [])];
    let changed = false;
    for (const target of targets) {
      if (target.sessionId && initializingChildren.has(target)) continue;
      try {
        const current = await snapshot(target);
        if (normalizeTimezone(current.timezone) !== entry.timezone) {
          await setZone(target, entry.timezone);
          const check = await snapshot(target);
          if (normalizeTimezone(check.timezone) !== entry.timezone) throw new Error('时区恢复后验证未通过');
          changed = true;
        }
      } catch (error) {
        if (target.sessionId && isMissingChild(error)) {
          children.get(tabId)?.delete(target.sessionId);
          overriddenChildren.delete(target);
          continue;
        }
        const message = '标签 ' + tabId + (target.sessionId ? ' 的子内容' : '') + ' 时区恢复失败。' + error.message.slice(0, 160);
        failures.push(message);
        // A disappearing or unconfirmed child does not invalidate the main page.
        if (!target.sessionId && !entry.error) entry.error = message;
        if (!entry.warnings.includes(message)) entry.warnings.push(message);
        entry.warnings = entry.warnings.slice(-8);
      }
    }
    if (changed) entry.needsReload = true;
    await badge(tabId, entry.error || entry.warnings.length ? '!' : 'TZ',
      entry.error ? '代理时区助手 · 时区需要重新应用' : '代理时区助手 · ' + entry.timezone);
  }
  await persist();
  return failures;
}

let repairScheduled = false;
function scheduleRepair() {
  if (repairScheduled) return;
  repairScheduled = true;
  serial(async () => {
    repairScheduled = false;
    await repairManaged();
  }).catch(() => { repairScheduled = false; });
}

async function clearManagedOverrides() {
  const failures = [];
  for (const [tabId] of managed) {
    const targets = [...(children.get(tabId)?.values() || [])].filter(target => overriddenChildren.has(target));
    targets.push({ tabId });
    for (const target of targets) {
      try { await setZone(target, ''); }
      catch (error) {
        // A child can disappear while the command is in flight.
        if (target.sessionId && !children.get(tabId)?.has(target.sessionId)) continue;
        failures.push('标签 ' + tabId + (target.sessionId ? ' 的子内容' : '') + ' 清除旧时区失败。' + error.message.slice(0, 160));
      }
    }
  }
  return failures;
}

async function applyGroup(timezone, primaryId) {
  const previousTimezone = settings.timezone;
  const previous = new Map([...managed].map(([tabId, entry]) => [tabId, { ...entry, warnings: [...entry.warnings] }]));
  const added = primaryId !== undefined && !managed.has(primaryId);
  if (primaryId !== undefined) await attach(primaryId, timezone);
  const mustClear = timezone !== previousTimezone || [...managed.values()].some(entry => entry.timezone !== timezone || entry.error);
  try {
    if (mustClear) {
      const failures = await clearManagedOverrides();
      if (failures.length) throw new Error(failures.join(' '));
      for (const tabId of managed.keys()) pendingReloads.delete(tabId);
    }
    const ids = [...managed.keys()];
    if (primaryId !== undefined) ids.sort((a, b) => a === primaryId ? -1 : b === primaryId ? 1 : 0);
    let actual = null;
    const warnings = [];
    for (const tabId of ids) {
      const result = await applyOne(tabId, timezone);
      if (tabId === primaryId) actual = result;
      else for (const message of managed.get(tabId).warnings) warnings.push('标签 ' + tabId + '。' + message);
    }
    settings.timezone = timezone;
    await persist();
    return { actual, warnings };
  } catch (error) {
    // Remove any new override before restoring the old group. Otherwise an
    // agent sharing that renderer can prevent the former owner from restoring.
    const recoveryFailures = await clearManagedOverrides();
    if (added) {
      try { await chrome.debugger.detach({ tabId: primaryId }); }
      catch (detachError) { recoveryFailures.push('新标签解除调试失败。' + detachError.message); }
      children.delete(primaryId);
      pendingReloads.delete(primaryId);
    }
    managed.clear();
    for (const [tabId, entry] of previous) managed.set(tabId, entry);
    settings.timezone = previousTimezone;
    recoveryFailures.push(...await repairManaged());
    const message = '时区更新失败，已尝试恢复此前时区。' + error.message.slice(0, 400);
    for (const [tabId, entry] of managed) {
      entry.error = (entry.error ? entry.error + ' ' : '') + message;
      entry.error = entry.error.slice(-1600);
      await badge(tabId, '!', '代理时区助手 · 更新失败，请打开扩展查看');
    }
    if (added) await badge(primaryId, '!', '代理时区助手 · 应用失败');
    await persist();
    throw new Error(message + (recoveryFailures.length ? ' 恢复过程也有异常。' + recoveryFailures.join(' ') : ''));
  }
}

async function schedule() {
  if (settings.autoSync) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  else await chrome.alarms.clear(ALARM_NAME);
}

async function stop(tabId) {
  const entry = managed.get(tabId);
  if (!entry) return;
  const failures = [];
  for (const target of children.get(tabId)?.values() || []) {
    try { await setZone(target, ''); } catch { /* May inherit the main process override. */ }
  }
  try { await setZone({ tabId }, ''); } catch (error) { failures.push(error.message); }
  try { await chrome.debugger.detach({ tabId }); } catch (error) { failures.push(error.message); }
  managed.delete(tabId);
  children.delete(tabId);
  pendingReloads.delete(tabId);
  autoReloads.delete(tabId);
  autoFailures.delete(tabId);
  await badge(tabId, '', '代理时区助手 · 已恢复，建议刷新页面');
  await persist();
  failures.push(...await repairManaged());
  if (failures.length) throw new Error('已移除管理记录，但恢复过程有异常。请关闭这个标签后重新打开。' + failures.join(' '));
}

// Applies the site rule and the adaptive "same as system" check to one tab.
// The caller serializes this work; navigation events may queue several calls.
async function ensureAuto(tabId, url, { allowReload = true, early = false } = {}) {
  if (!Number.isInteger(tabId) || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  if (!isAutoMode()) return;

  // A manual application on an auto-managed site is a temporary override for
  // that URL. It survives the APPLY-triggered reload, but the next navigation
  // lets the site rule take over again.
  const manualEntry = managed.get(tabId);
  if (manualEntry?.manual && manualEntry.manualUrl === url) return;
  if (manualEntry?.manual) {
    manualEntry.manual = false;
    delete manualEntry.manualUrl;
    if (!autoMatches(url) && settings.restoreOnLeave) {
      try { await stop(tabId); }
      catch (error) { await warn(tabId, '离开手动覆盖页面后恢复时区失败。' + error.message.slice(0, 160)); }
      return;
    }
  }

  if (!autoMatches(url)) {
    const entry = managed.get(tabId);
    if (entry?.auto && settings.restoreOnLeave) {
      try { await stop(tabId); }
      catch (error) { await warn(tabId, '离开站点后恢复时区失败。' + error.message.slice(0, 160)); }
    }
    return;
  }

  if (autoFailureBlocked(tabId, url)) return;

  let detection;
  try {
    detection = await ensureDetection();
  } catch (error) {
    const entry = managed.get(tabId);
    if (entry?.auto) {
      await badge(tabId, '!', '代理时区助手 · 出口查询失败，保留当前设置');
    } else {
      await badge(tabId, '!', '代理时区助手 · 自动启用失败：' + error.message.slice(0, 100));
    }
    if (!early) rememberAutoFailure(tabId, url, error.message);
    return;
  }

  const decision = decideAutoActivation({
    mode: settings.activation,
    sites: settings.sites,
    url,
    detectedTimezone: detection.timezone,
    systemTimezone: systemTimezone(),
    skipWhenLocal: settings.skipWhenLocal
  });
  if (!decision.activate) {
    if (decision.reason === 'same-as-system') {
      const entry = managed.get(tabId);
      if (entry?.auto) {
        try { await stop(tabId); }
        catch (error) { await warn(tabId, '出口恢复为本机时区后清理失败。' + error.message.slice(0, 160)); }
      } else {
        await badge(tabId, '', '代理时区助手 · 出口与本机时区一致，未启用');
      }
    }
    return;
  }

  // A tab may have navigated while the lookup was in flight. The next event
  // will handle the new URL; do not apply the old decision to a new page.
  // Early navigation calls intentionally skip this check: at that point the
  // tab still reports its previous URL, but attaching ahead of commit is useful.
  if (allowReload) {
    const latestUrl = await currentTabUrl(tabId);
    if (latestUrl && latestUrl !== url) return;
  }

  let entry = managed.get(tabId);
  try {
    if (!entry || entry.error || entry.timezone !== detection.timezone) {
      if (settings.timezone && settings.timezone !== detection.timezone && managed.size > 0) {
        // The whole extension keeps one timezone; keep existing tabs in sync.
        await applyGroup(detection.timezone, tabId);
      } else {
        await applyOne(tabId, detection.timezone);
      }
      entry = managed.get(tabId);
    }
    if (!entry) return;
    entry.auto = true;
    settings.timezone = detection.timezone;
    await persist();
  } catch (error) {
    if (!early) rememberAutoFailure(tabId, url, error.message);
    await badge(tabId, '!', '代理时区助手 · 自动启用失败：' + error.message.slice(0, 100));
    return;
  }

  if (entry.needsReload) {
    if (allowReload && settings.autoReload && !recentlyAutoReloaded(tabId, url)) {
      pendingReloads.add(tabId);
      autoReloads.set(tabId, { url, at: Date.now() });
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload');
      } catch (error) {
        pendingReloads.delete(tabId);
        autoReloads.delete(tabId);
        await warn(tabId, '自动刷新失败。请手动刷新页面。' + error.message.slice(0, 120));
      }
    } else {
      await badge(tabId, '!', '代理时区助手 · 已启用，刷新后首屏才会使用新时区');
    }
  } else if (!entry.warnings.length) {
    await badge(tabId, 'TZ', '代理时区助手 · 自动启用 · ' + detection.timezone);
  }
}

async function scanTabs({ allowReload = false } = {}) {
  if (!isAutoMode() || !chrome.tabs?.query) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id) || tab.discarded) continue;
    const url = tab.url || tab.pendingUrl;
    if (url) await ensureAuto(tab.id, url, { allowReload });
  }
}

async function handle(message) {
  switch (message?.type) {
    case 'STATUS': {
      let actual = null;
      const tab = managed.get(message.tabId);
      let auto = null;
      const url = await currentTabUrl(message.tabId);
      if (url) {
        auto = {
          url,
          matched: autoMatches(url),
          mode: settings.activation,
          systemTimezone: systemTimezone()
        };
      }
      if (tab) {
        try {
          actual = await snapshot({ tabId: message.tabId });
          if (normalizeTimezone(actual.timezone) !== tab.timezone) {
            tab.error = '页面实测时区与设置不一致。请重新应用。';
            await badge(message.tabId, '!', '代理时区助手 · 时区需要重新应用');
          }
        } catch (error) { tab.error = '无法验证当前标签。' + error.message; }
        await persist();
      }
      return { settings, tab: tab || null, actual, lookupError, auto, systemTimezone: systemTimezone() };
    }
    case 'DETECT': return { detection: await detect(), settings };
    case 'APPLY': {
      pendingReloads.delete(message.tabId);
      // Query first. A failed lookup never silently falls back to an old location.
      const timezone = message.detect
        ? (await detect()).timezone
        : normalizeTimezone(message.timezone);
      const { actual, warnings } = await applyGroup(timezone, message.tabId);
      const entry = managed.get(message.tabId);
      // A manual application takes precedence over the site rule until the
      // next navigation (or until auto mode is enabled again).
      entry.auto = false;
      entry.manual = true;
      entry.manualUrl = await currentTabUrl(message.tabId) || '';
      entry.warnings.push(...warnings);
      await persist();
      if (message.refresh) {
        pendingReloads.add(message.tabId);
        try {
          await chrome.debugger.sendCommand({ tabId: message.tabId }, 'Page.reload');
        } catch (error) {
          pendingReloads.delete(message.tabId);
          throw new Error('时区已应用，但刷新失败。请手动刷新页面。' + error.message);
        }
      }
      await schedule();
      return { timezone, snapshot: actual, warnings: [...entry.warnings] };
    }
    case 'VERIFY': {
      const entry = managed.get(message.tabId);
      if (!entry) throw new Error('这个标签还没有启用时区设置。');
      const actual = await snapshot({ tabId: message.tabId });
      if (normalizeTimezone(actual.timezone) !== entry.timezone) throw new Error('页面实测时区与设置不一致，请重新应用。');
      return { snapshot: actual };
    }
    case 'STOP': await stop(message.tabId); return {};
    case 'SET_AUTO':
      settings.autoSync = Boolean(message.enabled);
      await persist();
      await schedule();
      return { settings };
    case 'SET_ACTIVATION': {
      const activation = String(message.activation || '');
      if (!ACTIVATION_MODES.includes(activation)) throw new Error('不支持的启动方式。');
      settings.activation = activation;
      await persist();
      if (activation === 'manual') {
        for (const [tabId, entry] of [...managed]) {
          if (!entry.auto) continue;
          try { await stop(tabId); }
          catch (error) { await warn(tabId, '关闭自动启动后恢复时区失败。' + error.message.slice(0, 160)); }
        }
      } else {
        await scanTabs({ allowReload: false });
      }
      return { settings };
    }
    case 'SET_SITES': {
      settings.sites = parseSiteList(message.sites, { strict: true });
      await persist();
      if (settings.activation === 'sites') await scanTabs({ allowReload: false });
      return { settings };
    }
    case 'SET_AUTO_OPTIONS': {
      for (const key of ['autoReload', 'restoreOnLeave', 'skipWhenLocal']) {
        if (typeof message[key] === 'boolean') settings[key] = message[key];
      }
      await persist();
      if (isAutoMode()) await scanTabs({ allowReload: false });
      return { settings };
    }
    default: throw new Error('不支持的操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  serial(() => handle(message)).then(
    result => respond({ ok: true, ...result }),
    error => respond({ ok: false, error: error.message })
  );
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === 'Target.attachedToTarget') {
    initializeChild(source, params).catch(error => console.warn('Child initialization failed', error.message));
  } else if (method === 'Target.detachedFromTarget') {
    children.get(source.tabId)?.delete(params.sessionId);
    if (managed.has(source.tabId)) scheduleRepair();
  } else if (method === 'Page.frameNavigated' && !source.sessionId && !params.frame?.parentId) {
    serial(async () => {
      const entry = managed.get(source.tabId);
      if (!entry) return;
      // Navigation can change the renderer process. Reapply, then verify.
      // A new cross-site navigation can have run scripts before this event.
      try {
        await setZone({ tabId: source.tabId }, entry.timezone);
        const actual = await snapshot({ tabId: source.tabId });
        if (normalizeTimezone(actual.timezone) !== entry.timezone) throw new Error('导航后时区不一致');
        entry.needsReload = !pendingReloads.delete(source.tabId);
        await persist();
      } catch (error) { await warn(source.tabId, '导航后请重新应用并刷新。' + error.message.slice(0, 120)); }
      // The former renderer may still host another managed tab.
      await repairManaged();
    }).catch(() => {});
  }
});

chrome.debugger.onDetach.addListener(source => {
  // A queued detach event must not remove a newer attachment for this tab.
  const detachedEntry = managed.get(source.tabId);
  serial(async () => {
    if (!detachedEntry || managed.get(source.tabId) !== detachedEntry) return;
    const entry = detachedEntry;
    managed.delete(source.tabId);
    children.delete(source.tabId);
    pendingReloads.delete(source.tabId);
    autoReloads.delete(source.tabId);
    if (entry) await badge(source.tabId, 'OFF', '代理时区助手 · 已断开，打开扩展可重新应用');
    await persist();
    if (entry) await repairManaged();
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  serial(async () => {
    const entry = managed.get(tabId);
    managed.delete(tabId);
    children.delete(tabId);
    pendingReloads.delete(tabId);
    autoReloads.delete(tabId);
    autoFailures.delete(tabId);
    await persist();
    if (entry) await repairManaged();
  }).catch(() => {});
});

// Auto mode uses navigation events, not polling. onBeforeNavigate gives the
// earliest chance to attach; onCommitted verifies and can reload once.
chrome.webNavigation?.onBeforeNavigate?.addListener(details => {
  if (details.frameId !== 0) return;
  serial(() => ensureAuto(details.tabId, details.url, { allowReload: false, early: true })).catch(() => {});
});

chrome.webNavigation?.onCommitted?.addListener(details => {
  if (details.frameId !== 0) return;
  serial(() => ensureAuto(details.tabId, details.url, { allowReload: true })).catch(() => {});
});

chrome.webNavigation?.onHistoryStateUpdated?.addListener(details => {
  if (details.frameId !== 0) return;
  serial(() => ensureAuto(details.tabId, details.url, { allowReload: false, early: true })).catch(() => {});
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const url = changeInfo.url || tab?.url || tab?.pendingUrl;
  if (!url) return;
  serial(() => ensureAuto(tabId, url, {
    allowReload: changeInfo.status === 'complete',
    early: changeInfo.status !== 'complete'
  })).catch(() => {});
});

chrome.tabs?.onActivated?.addListener(({ tabId }) => {
  serial(async () => {
    if (!isAutoMode()) return;
    const url = await currentTabUrl(tabId);
    if (url) await ensureAuto(tabId, url, { allowReload: false });
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM_NAME) return;
  serial(async () => {
    if (!settings.autoSync || managed.size === 0) return;
    let detection;
    try { detection = await detect(); }
    catch (error) {
      for (const tabId of managed.keys()) await badge(tabId, '!', '代理时区助手 · 出口查询失败，保留原设置');
      return;
    }
    if (detection.timezone !== settings.timezone || [...managed.values()].some(entry => entry.error || entry.timezone !== detection.timezone)) {
      try { await applyGroup(detection.timezone); }
      catch (error) {
        for (const tabId of managed.keys()) await badge(tabId, '!', '代理时区助手 · 时区更新失败，已尝试恢复原设置');
      }
    }
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  serial(async () => {
    await schedule();
    await scanTabs({ allowReload: false });
  }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  serial(async () => {
    await schedule();
    await scanTabs({ allowReload: false });
  }).catch(() => {});
});

