export const LOOKUP_URL = 'https://ipwho.is/?fields=success,message,ip,country,region,city,timezone.id';
export const ALARM_NAME = 'proxy-timezone-sync';
export const ACTIVATION_MODES = Object.freeze(['manual', 'sites', 'all']);
export const DEFAULT_SETTINGS = Object.freeze({
  timezone: '',
  autoSync: false,
  detection: null,
  activation: 'manual',
  sites: Object.freeze([]),
  autoReload: true,
  restoreOnLeave: true,
  skipWhenLocal: true
});

export function normalizeTimezone(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) {
    throw new Error('请填写有效的 IANA 时区，例如 Asia/Singapore。');
  }
  const timezone = value.trim();
  if (/^[+-]/.test(timezone)) throw new Error('请使用城市时区名称，不要填写固定的 UTC 偏移。');
  try {
    return new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error('浏览器不认识这个时区，请检查拼写。');
  }
}

export function normalizeDetection(data, now = Date.now()) {
  if (!data || data.success !== true) throw new Error('出口查询失败。' + (typeof data?.message === 'string' ? data.message.slice(0, 160) : ''));
  if (typeof data.ip !== 'string' || data.ip.length > 64 || !/^[\da-fA-F:.]+$/.test(data.ip)) {
    throw new Error('查询服务没有返回有效的出口 IP。');
  }
  const text = value => typeof value === 'string' ? value.slice(0, 150) : '';
  return {
    ip: data.ip,
    country: text(data.country),
    region: text(data.region),
    city: text(data.city),
    timezone: normalizeTimezone(data.timezone?.id),
    checkedAt: now,
    provider: 'ipwho.is'
  };
}

export async function lookupExit(fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(LOOKUP_URL, {
      cache: 'no-store', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: controller.signal
    });
    if (!response.ok) throw new Error('出口查询服务返回 HTTP ' + response.status + '。请稍后重试，或手动设置时区。');
    const body = await response.text();
    if (body.length > 32768) throw new Error('出口查询响应过大，已停止处理。');
    let data;
    try { data = JSON.parse(body); } catch { throw new Error('出口查询服务返回了无法识别的内容。'); }
    return normalizeDetection(data);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('出口查询超时，请确认 ipwho.is 也经过代理。');
    if (error instanceof TypeError) throw new Error('无法连接出口查询服务。请检查代理，或手动设置时区。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Site rules are intentionally small and explicit. A bare host matches only
// that host; a leading "*." also matches the bare domain and its subdomains.
const parsedSitePatterns = new Map();
const MAX_SITE_PATTERNS = 100;

function globToRegExp(glob) {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + source + '$');
}

function normalizeHost(value) {
  if (!value || value.length > 255 || /[\s@#/\\]/.test(value)) {
    throw new Error('站点规则的主机名无效。');
  }
  const wildcard = value.startsWith('*.');
  const host = wildcard ? value.slice(2) : value;
  if (!host || host.includes('*')) throw new Error('站点规则只支持开头的 *. 通配符。');
  let parsed;
  try { parsed = new URL('http://' + host); } catch { throw new Error('站点规则的主机名无效。'); }
  if (!parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('站点规则的主机名无效。');
  }
  // URL lowercases hostnames and keeps IPv6 brackets.
  const normalized = parsed.hostname.toLowerCase();
  const port = parsed.port ? ':' + parsed.port : '';
  return { host: (wildcard ? '*.' : '') + normalized, port };
}

function parseSitePattern(value) {
  if (typeof value !== 'string') throw new Error('站点规则必须是文本。');
  let text = value.trim();
  if (!text || text.length > 400) throw new Error('站点规则不能为空，且不能超过 400 个字符。');
  if (text.startsWith('//')) text = '*:' + text;
  if (!/^[a-z*]+:\/\//i.test(text)) text = '*://' + text;
  const match = /^(\*|https?):\/\/([^/]*)(\/.*)?$/i.exec(text);
  if (!match) throw new Error('站点规则格式无效。');
  const scheme = match[1].toLowerCase();
  const { host, port } = normalizeHost(match[2].toLowerCase());
  let path = match[3] || '/*';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.includes('#')) throw new Error('站点规则不支持 # 片段。');
  return { raw: value, scheme, host, port, path, pathRegExp: globToRegExp(path) };
}

function cachedPattern(value) {
  let parsed = parsedSitePatterns.get(value);
  if (!parsed) {
    parsed = parseSitePattern(value);
    parsedSitePatterns.set(value, parsed);
  }
  return parsed;
}

export function normalizeSitePattern(value) {
  const parsed = parseSitePattern(value);
  return parsed.scheme + '://' + parsed.host + parsed.port + parsed.path;
}

export function matchesSite(pattern, urlString) {
  let url;
  try { url = new URL(urlString); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  let rule;
  try { rule = cachedPattern(pattern); } catch { return false; }
  const scheme = url.protocol.slice(0, -1);
  if (rule.scheme !== '*' && rule.scheme !== scheme) return false;
  const hostname = url.hostname.toLowerCase();
  if (rule.host.startsWith('*.')) {
    const base = rule.host.slice(2);
    if (hostname !== base && !hostname.endsWith('.' + base)) return false;
  } else if (hostname !== rule.host) {
    return false;
  }
  if (rule.port) {
    const defaultPort = scheme === 'https' ? '443' : '80';
    if ((url.port || defaultPort) !== rule.port.slice(1)) return false;
  }
  return rule.pathRegExp.test(url.pathname + url.search);
}

export function matchesAnySite(patterns, urlString) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some(pattern => matchesSite(pattern, urlString));
}

export function parseSiteList(value, { strict = true } = {}) {
  const lines = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index++) {
    const line = String(lines[index] ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const normalized = normalizeSitePattern(line);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    } catch (error) {
      if (strict) throw new Error('第 ' + (index + 1) + ' 行：' + error.message);
    }
  }
  if (result.length > MAX_SITE_PATTERNS) throw new Error('站点规则最多 ' + MAX_SITE_PATTERNS + ' 条。');
  return result;
}

function cleanDetection(value) {
  if (!value || typeof value !== 'object' || typeof value.timezone !== 'string') return null;
  return {
    ip: typeof value.ip === 'string' ? value.ip.slice(0, 64) : '',
    country: typeof value.country === 'string' ? value.country.slice(0, 150) : '',
    region: typeof value.region === 'string' ? value.region.slice(0, 150) : '',
    city: typeof value.city === 'string' ? value.city.slice(0, 150) : '',
    timezone: value.timezone.slice(0, 100),
    checkedAt: Number.isFinite(value.checkedAt) ? value.checkedAt : 0,
    provider: 'ipwho.is'
  };
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    timezone: typeof source.timezone === 'string' ? source.timezone.slice(0, 100) : '',
    autoSync: Boolean(source.autoSync),
    detection: cleanDetection(source.detection),
    activation: ACTIVATION_MODES.includes(source.activation) ? source.activation : 'manual',
    sites: parseSiteList(source.sites, { strict: false }),
    autoReload: source.autoReload !== false,
    restoreOnLeave: source.restoreOnLeave !== false,
    skipWhenLocal: source.skipWhenLocal !== false
  };
}

export function decideAutoActivation({ mode, sites = [], url, detectedTimezone, systemTimezone, skipWhenLocal = true }) {
  if (mode === 'manual') return { activate: false, reason: 'manual' };
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { activate: false, reason: 'not-http' };
  if (mode === 'sites' && !matchesAnySite(sites, url)) return { activate: false, reason: 'site-mismatch' };
  if (typeof detectedTimezone !== 'string' || !detectedTimezone) return { activate: false, reason: 'no-timezone' };
  if (skipWhenLocal && detectedTimezone === systemTimezone) return { activate: false, reason: 'same-as-system' };
  return { activate: true, reason: 'active' };
}

// Executed by the browser in the selected page. No page DOM or account data is read.
export const SNAPSHOT_EXPRESSION = `(() => {
  const year = new Date().getUTCFullYear();
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: new Date().getTimezoneOffset(),
    winterOffset: new Date(Date.UTC(year, 0, 15, 12)).getTimezoneOffset(),
    summerOffset: new Date(Date.UTC(year, 6, 15, 12)).getTimezoneOffset(),
    date: new Date().toString()
  };
})()`;
