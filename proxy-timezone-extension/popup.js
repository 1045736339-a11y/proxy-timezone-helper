'use strict';

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element]),
);
let tabId = null;
let busy = false;
let latestStatus = null;
let lastSnapshot = null;
let lastWarnings = [];
let sitesDirty = false;

function setText(id, value) {
  elements[id].textContent = value === undefined || value === null || value === '' ? '—' : String(value);
}

function showMessage(message, kind = '') {
  elements.message.hidden = !message;
  elements.message.textContent = message || '';
  elements.message.className = ['message', kind].filter(Boolean).join(' ');
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatOffset(value) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '—';
  // Date#getTimezoneOffset returns minutes west of UTC.
  const utcMinutes = -value;
  const sign = utcMinutes >= 0 ? '+' : '-';
  const magnitude = Math.abs(utcMinutes);
  return 'UTC' + sign + String(Math.floor(magnitude / 60)).padStart(2, '0') + ':' + String(magnitude % 60).padStart(2, '0');
}

function warningText(warnings) {
  if (!warnings) return [];
  return (Array.isArray(warnings) ? warnings : [warnings])
    .map((warning) => typeof warning === 'string' ? warning : warning?.message || JSON.stringify(warning))
    .filter(Boolean);
}

function updateControls() {
  const requiresTab = ['detect-apply', 'manual-apply', 'verify', 'stop'];
  for (const id of requiresTab) elements[id].disabled = busy || tabId === null;
  elements.detect.disabled = busy;
  elements['auto-sync'].disabled = busy;
  elements['manual-timezone'].disabled = busy;
  elements.refresh.disabled = busy;
  for (const id of ['auto-reload', 'restore-on-leave', 'skip-when-local', 'sites', 'save-sites']) {
    elements[id].disabled = busy;
  }
  elements['add-current-site'].disabled = busy || tabId === null;
  for (const radio of document.querySelectorAll('input[name="activation"]')) radio.disabled = busy;
  if (!busy && latestStatus) elements.stop.disabled = !latestStatus.tab;
}

function selectedActivation() {
  return document.querySelector('input[name="activation"]:checked')?.value || 'manual';
}

function renderAutoState(status) {
  const activation = status.settings?.activation || 'manual';
  const auto = status.auto;
  let text = '';
  if (activation === 'manual') {
    text = '手动模式：自动规则未启用。';
  } else if (activation === 'all') {
    text = '所有普通网页都会自动启用；标签上会出现调试提示。';
  } else if (!auto) {
    text = '指定网站模式：无法读取当前网站。';
  } else if (auto.matched) {
    text = '本站匹配站点规则，进入时会自动启用。';
  } else {
    text = '本站不在站点规则中，不会自动启用。';
  }
  elements['auto-state'].hidden = !text;
  elements['auto-state'].textContent = text;
}

function renderActivation(settings) {
  const activation = ['manual', 'sites', 'all'].includes(settings.activation) ? settings.activation : 'manual';
  for (const radio of document.querySelectorAll('input[name="activation"]')) {
    radio.checked = radio.value === activation;
  }
  elements['site-settings'].hidden = activation !== 'sites';
  elements['auto-options'].hidden = activation === 'manual';
  elements['auto-reload'].checked = settings.autoReload !== false;
  elements['restore-on-leave'].checked = settings.restoreOnLeave !== false;
  elements['skip-when-local'].checked = settings.skipWhenLocal !== false;
  if (!sitesDirty && document.activeElement !== elements.sites) {
    elements.sites.value = (settings.sites || []).join('\n');
  }
}

function renderStatus(status) {
  latestStatus = status;
  const tab = status.tab;
  const settings = status.settings || {};
  const actual = tab ? status.actual || null : null;
  const detection = settings.detection || status.detection;
  renderActivation(settings);
  renderAutoState(status);
  elements.badge.textContent = tab?.error ? '需重试' : tab ? '已启用' : '未启用';
  elements.badge.classList.toggle('enabled', Boolean(tab));
  setText('configured-timezone', tab?.timezone || '未设置');
  setText('actual-timezone', actual?.timezone);
  setText('actual-offset', formatOffset(actual?.offset));
  setText('season-offsets', actual ? formatOffset(actual.winterOffset) + ' / ' + formatOffset(actual.summerOffset) : '—');
  setText('applied-at', tab?.appliedAt ? '应用于 ' + formatTime(tab.appliedAt) : '');
  elements['applied-at'].hidden = !tab?.appliedAt;
  setText('verified-at', actual?.date ? '页面时间 ' + actual.date : '');
  elements['verified-at'].hidden = !actual?.date;
  elements['auto-sync'].checked = Boolean(settings.autoSync);
  elements['reload-notice'].hidden = !tab?.needsReload;

  if (detection) {
    setText('detected-ip', detection.ip);
    const location = [detection.city, detection.region, detection.country || detection.country_name]
      .filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ');
    setText('detected-location', location);
    setText('detected-timezone', typeof detection.timezone === 'object' ? detection.timezone?.id : detection.timezone);
    setText('detected-at', formatTime(detection.checkedAt || detection.detectedAt || detection.queriedAt || detection.timestamp));
  } else {
    setText('detected-ip', '尚未查询');
    for (const id of ['detected-location', 'detected-timezone', 'detected-at']) setText(id, null);
  }
  const lookupError = status.lookupError;
  elements['lookup-error'].hidden = !lookupError;
  elements['lookup-error'].textContent = lookupError
    ? '最近查询失败。' + (typeof lookupError === 'string' ? lookupError : lookupError.message || '未知错误')
      + (lookupError.at ? '\n发生时间 ' + formatTime(lookupError.at) : '')
    : '';

  const warnings = [...warningText(tab?.warnings), ...lastWarnings];
  if (tab?.error) warnings.push('本页状态异常。' + (typeof tab.error === 'string' ? tab.error : tab.error.message || JSON.stringify(tab.error)));
  elements.warnings.textContent = [...new Set(warnings)].join('\n');
  elements.warnings.hidden = warnings.length === 0;
  updateControls();
}

async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result || result.ok !== true) {
    const error = result?.error;
    throw new Error(typeof error === 'string' ? error : error?.message || '扩展未返回有效结果。请重新打开弹窗再试。');
  }
  return result;
}

async function refreshStatus() {
  const status = await send('STATUS', { tabId });
  renderStatus(status);
}

async function run(operation, progressMessage) {
  if (busy) return;
  busy = true;
  updateControls();
  showMessage(progressMessage, 'busy');
  let resultMessage = '';
  let operationError = null;
  try {
    resultMessage = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await refreshStatus();
  } catch (error) {
    if (!operationError) operationError = new Error('操作后无法读取状态。' + (error.message || error));
  }
  busy = false;
  updateControls();
  if (operationError) showMessage(operationError.message || String(operationError), 'error');
  else showMessage(resultMessage);
}

elements['detect-apply'].addEventListener('click', () => run(async () => {
  const result = await send('APPLY', { tabId, detect: true, refresh: elements.refresh.checked });
  lastSnapshot = result.snapshot || null;
  lastWarnings = warningText(result.warnings);
  return '已应用 ' + (result.timezone || result.snapshot?.timezone || '出口时区') + '。'
    + (elements.refresh.checked ? '已请求刷新当前页。' : '可验证当前页的实际时区。');
}, '正在查询出口并应用时区…'));

elements.detect.addEventListener('click', () => run(async () => {
  await send('DETECT');
  return '出口查询完成。点击“查询出口并应用”可更新当前页。';
}, '正在查询出口 IP 和时区…'));

elements['manual-apply'].addEventListener('click', () => run(async () => {
  const timezone = elements['manual-timezone'].value.trim();
  if (!timezone) throw new Error('请先填写完整的 IANA 时区名称。');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new Error('这个 IANA 时区名称无效。请检查拼写后再试。');
  }
  const result = await send('APPLY', { tabId, timezone, refresh: elements.refresh.checked });
  lastSnapshot = result.snapshot || null;
  lastWarnings = warningText(result.warnings);
  return '已应用 ' + (result.timezone || timezone) + '。'
    + (elements.refresh.checked ? '已请求刷新当前页。' : '可验证当前页的实际时区。');
}, '正在应用手动时区…'));

elements['auto-sync'].addEventListener('change', () => run(async () => {
  const enabled = elements['auto-sync'].checked;
  await send('SET_AUTO', { enabled });
  return enabled ? '已启用定时检查。时区变化后不会自动刷新页面。' : '已关闭定时检查。';
}, '正在保存定时检查设置…'));

for (const radio of document.querySelectorAll('input[name="activation"]')) {
  radio.addEventListener('change', () => run(async () => {
    const activation = selectedActivation();
    await send('SET_ACTIVATION', { activation });
    if (activation === 'manual') return '已切换为手动启动。已自动启用的标签会恢复原时区。';
    if (activation === 'all') return '已切换为所有网站自动启动。';
    return '已切换为指定网站自动启动。请填写站点规则。';
  }, '正在保存启动方式…'));
}

for (const [id, key, label] of [
  ['auto-reload', 'autoReload', '首次进入自动刷新'],
  ['restore-on-leave', 'restoreOnLeave', '离开站点后恢复'],
  ['skip-when-local', 'skipWhenLocal', '出口同时区时跳过'],
]) {
  elements[id].addEventListener('change', () => run(async () => {
    await send('SET_AUTO_OPTIONS', { [key]: elements[id].checked });
    return label + (elements[id].checked ? '已开启。' : '已关闭。');
  }, '正在保存自动选项…'));
}

elements.sites.addEventListener('input', () => { sitesDirty = true; });

elements['save-sites'].addEventListener('click', () => run(async () => {
  const result = await send('SET_SITES', { sites: elements.sites.value });
  sitesDirty = false;
  elements.sites.value = result.settings.sites.join('\n');
  return '已保存 ' + result.settings.sites.length + ' 条站点规则。';
}, '正在保存站点规则…'));

elements['add-current-site'].addEventListener('click', () => run(async () => {
  let url = latestStatus?.auto?.url || null;
  if (!url && tabId !== null) {
    const tab = await chrome.tabs.get(tabId);
    url = tab?.url || tab?.pendingUrl || null;
  }
  if (!url) throw new Error('无法读取当前网站地址。');
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error('当前网站地址无效。'); }
  if (!host) throw new Error('当前页面没有可添加的网站地址。');
  const lines = elements.sites.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.some(line => line === host || line === '*.' + host)) return '当前网站已经在规则中。';
  lines.push(host);
  const result = await send('SET_SITES', { sites: lines });
  sitesDirty = false;
  elements.sites.value = result.settings.sites.join('\n');
  const base = host.startsWith('www.') ? host.slice(4) : host;
  return '已添加 ' + host + '。如需同时匹配子域，可改成 *.' + base + '。';
}, '正在添加当前网站…'));

elements.verify.addEventListener('click', () => run(async () => {
  const result = await send('VERIFY', { tabId });
  lastSnapshot = result.snapshot || null;
  const configured = latestStatus?.tab?.timezone;
  if (configured && result.snapshot?.timezone && configured !== result.snapshot.timezone) {
    return '页面实测为 ' + result.snapshot.timezone + '，与本页设置不同。可重新应用后再验证。';
  }
  return '验证完成。页面实测时区为 ' + (result.snapshot?.timezone || '未知') + '。';
}, '正在读取当前页的时区…'));

elements.stop.addEventListener('click', () => run(async () => {
  await send('STOP', { tabId });
  lastSnapshot = null;
  lastWarnings = [];
  return '已停止对当前页设置时区。页面中已有的日期显示可能需要刷新。';
}, '正在恢复当前页的浏览器时区…'));

async function initialize() {
  busy = true;
  updateControls();
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    tabId = Number.isInteger(tab?.id) ? tab.id : null;
    let pageLabel = tab?.title || '当前标签';
    if (tab?.url) {
      try {
        const url = new URL(tab.url);
        pageLabel = url.hostname || pageLabel;
      } catch { /* A title is sufficient when the URL is unavailable. */ }
    }
    setText('current-page', pageLabel);
    await refreshStatus();
    if (tabId === null) showMessage('没有可操作的标签。请先打开一个网页。', 'error');
  } catch (error) {
    elements.badge.textContent = '读取失败';
    showMessage(error.message || String(error), 'error');
  } finally {
    busy = false;
    updateControls();
  }
}

initialize();
