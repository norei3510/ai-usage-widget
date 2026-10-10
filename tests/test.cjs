// Run: node --test outputs/tests/test.cjs (or node --test tests/test.cjs from outputs).
// Tests use synthetic credentials and mocked transport only. No network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'AI Usage.js'), 'utf8');
const declarations = source.split('// SCRIPTABLE ENTRY')[0];
const sandbox = { Buffer };
vm.createContext(sandbox);
vm.runInContext(declarations + '\nglobalThis.core = AIUsageCore;', sandbox);
const C = sandbox.core;
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const NOW = Date.parse('2026-10-07T12:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
const jwt = (exp = NOW / 1000 + 7200, account = 'synthetic-account') =>
  'fixture.' + Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url') + '.fixture';
const reply = (json, status = 200, headers = {}) => ({ body: JSON.stringify(json), status, headers });

function setup(overrides = {}) {
  let time = NOW;
  let id = 0;
  const files = new Map();
  const keys = new Map();
  const calls = [];
  const env = {
    now: () => time, newID: () => 'fixture-lock-' + (++id),
    decodeBase64: value => Buffer.from(value, 'base64').toString('utf8'),
    keychain: { contains: key => keys.has(key), get: key => keys.get(key),
      set: (key, value) => keys.set(key, value), remove: key => keys.delete(key) },
    readJSON: name => files.has(name) ? clone(files.get(name)) : null,
    writeJSON: (name, value) => files.set(name, clone(value)),
    removeFile: name => files.delete(name),
    http: async (url, options) => {
      calls.push({ url, options });
      return reply(url === C.URLS.go ? fixtures.opencodeGo : fixtures.codex);
    },
    ...overrides,
  };
  const ctl = C.createController(env);
  return { env, ctl, files, keys, calls, advance: ms => { time += ms; },
    auth: () => { keys.set(C.KEYS.access, jwt()); keys.set(C.KEYS.refresh, 'synthetic-refresh'); keys.set(C.KEYS.account, 'synthetic-account'); keys.set(C.KEYS.go, 'synthetic-go-key'); } };
}

test('source parses as one Scriptable program, including top-level await', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction(source));
});

test('Codex identifies quotas by duration, regardless of primary/secondary position', () => {
  const windows = C.parseCodex(fixtures.codex, NOW);
  assert.equal(windows[0].id, 'fiveHour');
  assert.equal(windows[0].remainingPercent, 99);
  assert.equal(windows[1].remainingPercent, 50);
  assert.equal(windows[0].resetAt, NOW + 3600000);
  assert.equal(windows[1].resetAt, 1791763200000);
});

test('unknown and duplicate Codex durations remain unavailable', () => {
  const json = clone(fixtures.codex);
  json.rate_limit.secondary_window.limit_window_seconds = 100;
  assert.equal(C.parseCodex(json, NOW)[0].status, 'unavailable');
  json.rate_limit.secondary_window.limit_window_seconds = 604800;
  assert.throws(() => C.parseCodex(json, NOW), /no_valid_windows/);
});

test('official Go API schema keeps 1 as 1% usage; ISO reset parsed', () => {
  const windows = C.parseGo(fixtures.opencodeGo, NOW);
  assert.equal(windows[0].remainingPercent, 99);
  assert.equal(windows[0].resetAt, Date.parse('2026-10-07T14:42:00Z'));
  assert.equal(windows[2].remainingPercent, 0);
});

test('usage and color boundaries match requirements', () => {
  const cases = [[0, 100, 'green'], [1, 99, 'green'], [20, 80, 'green'], [50, 50, 'orange'], [100, 0, 'red'],
    [49.9, 50.1, 'green'], [79.9, 20.1, 'orange'], [80, 20, 'red']];
  for (const [used, remaining, color] of cases) {
    const json = clone(fixtures.opencodeGo);
    json.usage.rolling.percent = used;
    const row = C.parseGo(json, NOW)[0];
    assert.ok(Math.abs(row.remainingPercent - remaining) < 1e-8);
    assert.equal(C.remainingColor(row.remainingPercent), color);
  }
});

test('missing, null, strings, booleans, NaN, infinities, negatives, excess never become 100% remaining', () => {
  for (const invalid of [undefined, null, '', '0', false, NaN, Infinity, -1, 101, {}, []]) {
    const go = clone(fixtures.opencodeGo);
    go.usage.rolling.percent = invalid;
    const row = C.parseGo(go, NOW)[0];
    assert.equal(row.status, 'unavailable');
    assert.equal(row.remainingPercent, null);
    const codex = clone(fixtures.codex);
    codex.rate_limit.secondary_window.used_percent = invalid;
    assert.equal(C.parseCodex(codex, NOW)[0].remainingPercent, null);
  }
});

test('partial Go data displays verified windows; unknown formats and all empty fail', () => {
  const json = clone(fixtures.opencodeGo);
  delete json.usage.weekly;
  assert.equal(C.parseGo(json, NOW)[1].status, 'unavailable');
  assert.equal(C.parseGo(json, NOW)[2].status, 'ok');
  assert.throws(() => C.parseGo(fixtures.unknownGo, NOW), /invalid_schema/);
  assert.throws(() => C.parseGo({ usage: {} }, NOW), /no_valid_windows/);
  json.usage.rolling.status = 'unexpected';
  assert.equal(C.parseGo(json, NOW)[0].status, 'unavailable');
});

test('explicit Go ratio variant works, with no missing-value fallback or clamping', () => {
  const windows = C.parseGo(fixtures.opencodeGoRatioVariant, NOW);
  assert.equal(windows[0].remainingPercent, 99);
  assert.equal(windows[2].remainingPercent, null);
  const bad = clone(fixtures.opencodeGoRatioVariant);
  bad.usage.rolling.limit = 0;
  assert.equal(C.parseGo(bad, NOW)[0].remainingPercent, null);
  bad.usage.rolling = { used: 200, limit: 100 };
  assert.equal(C.parseGo(bad, NOW)[0].remainingPercent, null);
});

test('conflicting percentage aliases are rejected instead of picking a favorable value', () => {
  const json = clone(fixtures.opencodeGo);
  json.usage.rolling.usagePercent = 50;
  assert.equal(C.parseGo(json, NOW)[0].status, 'unavailable');
});

test('reset seconds, milliseconds and timezone ISO are explicit; ambiguous Go numeric reset rejected', () => {
  assert.equal(C.absoluteTime(1791374400, 'seconds'), NOW);
  assert.equal(C.absoluteTime(NOW, 'milliseconds'), NOW);
  assert.equal(C.absoluteTime('2026-10-07T21:00:00+09:00', 'iso'), NOW);
  assert.equal(C.absoluteTime('2026-10-07T21:00:00', 'iso'), null);
  assert.equal(C.relativeTime(600, NOW), NOW + 600000);
  assert.equal(C.relativeTime(-1, NOW), null);
  const json = clone(fixtures.opencodeGo);
  json.usage.rolling.resetsAt = NOW / 1000;
  const row = C.parseGo(json, NOW)[0];
  assert.equal(row.resetAt, null);
  assert.equal(row.remainingPercent, 99);
  assert.equal(row.resetStatus, 'invalid');
});

test('missing/invalid reset remains unknown without suppressing a valid percent', () => {
  const json = clone(fixtures.codex);
  delete json.rate_limit.secondary_window.reset_after_seconds;
  assert.equal(C.parseCodex(json, NOW)[0].resetStatus, 'unknown');
  json.rate_limit.secondary_window.reset_at = null;
  assert.equal(C.parseCodex(json, NOW)[0].resetStatus, 'invalid');
});

test('cache does not shift a relative reset or stamp a new successful time', async () => {
  const s = setup(); s.auth();
  const first = await s.ctl.loadProvider('codex');
  s.advance(3600001);
  s.env.http = async () => { throw new Error('synthetic network exception'); };
  const failed = await s.ctl.loadProvider('codex');
  assert.equal(failed.status, 'stale');
  assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.equal(failed.windows[0].resetAt, first.windows[0].resetAt);
  assert.equal(failed.windows[0].remainingPercent, 99);
  assert.equal(C.isOld(failed, NOW + 3600001), true);
  assert.match(C.formatReset(failed.windows[0].resetAt, NOW + 3600001, true), /時刻経過・要更新/);
});

test('corrupt and inconsistent caches are ignored, unknown cache fields cannot leak', async () => {
  const s = setup(); s.auth();
  await s.ctl.loadProvider('opencodeGo');
  const cache = s.files.get('cache-opencodeGo');
  cache.secret = 'synthetic-sensitive-value';
  assert.equal(s.ctl.getCache('opencodeGo').secret, undefined);
  cache.windows[0].remainingPercent = 100;
  assert.equal(s.ctl.getCache('opencodeGo'), null);
  cache.windows[0].remainingPercent = 99;
  cache.fetchedAt = NOW + 120000;
  assert.equal(s.ctl.getCache('opencodeGo'), null);
  s.env.readJSON = () => { throw new SyntaxError('fixture broken JSON'); };
  assert.equal(s.ctl.getCache('opencodeGo'), null);
  // A corrupt disk cache must not prevent fresh verified data from replacing it.
  assert.equal((await s.ctl.loadProvider('opencodeGo')).status, 'ok');
});

test('providers fetch independently and concurrently, one failure preserves the other', async () => {
  let started = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = setup({ http: async url => {
    if (++started === 2) release();
    await gate;
    if (url === C.URLS.codex) throw new Error('fixture offline');
    return reply(fixtures.opencodeGo);
  } }); s.auth();
  const results = await s.ctl.loadAll();
  assert.equal(started, 2);
  assert.equal(results.codex.status, 'fetchError');
  assert.equal(results.opencodeGo.status, 'ok');
});

test('first run unconfigured performs no requests; errors have no successful percent', async () => {
  const s = setup();
  const results = await s.ctl.loadAll();
  assert.equal(s.calls.length, 0);
  for (const result of Object.values(results)) {
    assert.equal(result.status, 'unconfigured');
    assert.equal(result.fetchedAt, null);
    assert.ok(result.windows.every(row => row.remainingPercent === null));
  }
});

test('Codex expiry refresh saves rotated refresh before access and usage request', async () => {
  const s = setup(); s.auth(); s.keys.set(C.KEYS.access, jwt(NOW / 1000 - 1));
  const order = [];
  s.env.keychain.set = (key, value) => { order.push(key); s.keys.set(key, value); };
  s.env.http = async (url, options) => {
    s.calls.push({ url, options });
    if (url === C.URLS.token) return reply({ access_token: jwt(NOW / 1000 + 10000), refresh_token: 'synthetic-rotated' });
    assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-rotated');
    return reply(fixtures.codex);
  };
  const result = await s.ctl.loadProvider('codex');
  assert.equal(result.status, 'ok');
  assert.equal(s.calls.length, 2);
  assert.equal(order[0], C.KEYS.refresh);
  assert.equal(order[1], C.KEYS.access);
});

test('401 refreshes and retries usage exactly once; second 401 propagates', async () => {
  const s = setup(); s.auth(); let usageCalls = 0, tokenCalls = 0;
  s.env.http = async url => {
    if (url === C.URLS.token) { tokenCalls++; return reply({ access_token: jwt(NOW / 1000 + 8000), refresh_token: 'synthetic-new' }); }
    usageCalls++; return reply({}, 401);
  };
  const result = await s.ctl.loadProvider('codex');
  assert.equal(result.status, 'authError');
  assert.equal(tokenCalls, 1); assert.equal(usageCalls, 2);
  assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-new');
});

test('401 followed by refresh success fetches using new token and derived account', async () => {
  const s = setup(); s.auth(); let count = 0;
  const fresh = jwt(NOW / 1000 + 9000, 'synthetic-new-account');
  s.env.http = async (url, options) => {
    if (url === C.URLS.token) return reply({ access_token: fresh, refresh_token: 'synthetic-rotated-2' });
    if (++count === 1) return reply({}, 401);
    assert.equal(options.headers.Authorization, 'Bearer ' + fresh);
    assert.equal(options.headers['ChatGPT-Account-Id'], 'synthetic-new-account');
    return reply(fixtures.codex);
  };
  assert.equal((await s.ctl.loadProvider('codex')).status, 'ok');
});

test('refresh denial preserves existing credentials and previous successful cache', async () => {
  const s = setup(); s.auth(); await s.ctl.loadProvider('codex');
  s.keys.set(C.KEYS.access, jwt(NOW / 1000 - 100));
  const before = s.keys.get(C.KEYS.refresh);
  s.env.http = async () => reply({ error_description: 'synthetic-private-message' }, 400);
  const result = await s.ctl.loadProvider('codex');
  assert.equal(result.status, 'authError');
  assert.equal(result.errorCode, 'auth_rejected');
  assert.equal(result.fetchedAt, NOW);
  assert.equal(s.keys.get(C.KEYS.refresh), before);
  assert.ok(!JSON.stringify(result).includes('synthetic-private-message'));
});

test('active refresh lock uses cache without refresh; expired lock permits renewal', async () => {
  const s = setup(); s.auth(); await s.ctl.loadProvider('codex');
  s.keys.set(C.KEYS.access, jwt(NOW / 1000 - 1));
  s.files.set('refresh-lock', { owner: 'synthetic-other-owner', expiresAt: NOW + 60000 });
  s.calls.length = 0;
  const busy = await s.ctl.loadProvider('codex');
  assert.equal(busy.errorCode, 'refresh_busy'); assert.equal(busy.fetchedAt, NOW);
  assert.equal(s.calls.length, 0);
  s.advance(61000);
  s.env.http = async url => url === C.URLS.token ? reply({ access_token: jwt(NOW / 1000 + 12000) }) : reply(fixtures.codex);
  assert.equal((await s.ctl.loadProvider('codex')).status, 'ok');
});

test('refresh failure reuses concurrently changed saved credentials without retrying refresh', async () => {
  const s = setup(); s.auth(); s.keys.set(C.KEYS.access, jwt(NOW / 1000 - 1));
  let refreshCalls = 0;
  s.env.http = async url => {
    if (url === C.URLS.token) {
      refreshCalls++;
      s.keys.set(C.KEYS.access, jwt(NOW / 1000 + 18000));
      s.keys.set(C.KEYS.refresh, 'synthetic-other-rotation');
      return reply({}, 400);
    }
    return reply(fixtures.codex);
  };
  assert.equal((await s.ctl.loadProvider('codex')).status, 'ok');
  assert.equal(refreshCalls, 1);
  assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-other-rotation');
});

test('saved credentials are reread immediately after lock claim', async () => {
  const s = setup(); s.auth(); s.keys.set(C.KEYS.access, jwt(NOW / 1000 - 1));
  const originalWrite = s.env.writeJSON;
  s.env.writeJSON = (name, value) => {
    originalWrite(name, value);
    if (name === 'refresh-lock' && value.owner) s.keys.set(C.KEYS.refresh, 'synthetic-latest-refresh');
  };
  s.env.http = async (url, options) => {
    if (url === C.URLS.token) {
      assert.match(options.body, /refresh_token=synthetic-latest-refresh/);
      return reply({ access_token: jwt(), refresh_token: 'synthetic-rotated-latest' });
    }
    return reply(fixtures.codex);
  };
  assert.equal((await s.ctl.loadProvider('codex')).status, 'ok');
});

test('429 backoff survives next execution and expires, including HTTP date Retry-After', async () => {
  const s = setup(); s.auth(); let attempts = 0;
  s.env.http = async () => { attempts++; return reply({}, 429, { 'Retry-After': '120' }); };
  const first = await s.ctl.loadProvider('opencodeGo');
  assert.equal(first.retryAfterAt, NOW + 120000);
  const nextController = C.createController(s.env);
  assert.equal((await nextController.loadProvider('opencodeGo')).errorCode, 'rate_limited');
  assert.equal(attempts, 1);
  s.advance(121000);
  await nextController.loadProvider('opencodeGo'); assert.equal(attempts, 2);
  assert.equal(C.retryAfter(new Date(NOW + 300000).toUTCString(), NOW), NOW + 300000);
  assert.equal(C.retryAfter(null, NOW), NOW + 900000);
});

test('403, 5xx, invalid JSON and transport failure have distinct sanitized codes', async () => {
  for (const [response, code] of [[reply({}, 403), 'http_403'], [reply({}, 503), 'http_5xx'],
    [{ status: 200, headers: {}, body: '<html>synthetic-private-html</html>' }, 'invalid_json']]) {
    const s = setup({ http: async () => response }); s.auth();
    const result = await s.ctl.loadProvider('opencodeGo');
    assert.equal(result.errorCode, code); assert.equal(result.fetchedAt, null);
    if (code === 'http_403') assert.equal(C.providerState(result, NOW), '権限・契約を確認');
  }
  const s = setup({ http: async () => { throw new Error('Authorization: synthetic-private-key'); } }); s.auth();
  const result = await s.ctl.loadProvider('opencodeGo');
  assert.equal(result.errorCode, 'network_error');
  assert.ok(!JSON.stringify(result).includes('synthetic-private-key'));
});

test('old age boundary is >=30 minutes; dates use device timezone and include another year', () => {
  assert.equal(C.isOld({ fetchedAt: NOW }, NOW + 1799999), false);
  assert.equal(C.isOld({ fetchedAt: NOW }, NOW + 1800000), true);
  // Run suite under TZ=Asia/Tokyo; this ensures the requirement example is exact.
  if (process.env.TZ === 'Asia/Tokyo') {
    assert.equal(C.formatReset(Date.parse('2026-10-07T14:42:00Z'), NOW), '↻ 23:42');
    assert.equal(C.formatReset(Date.parse('2026-10-12T00:15:00Z'), NOW), '↻ 10/12 09:15');
  }
  assert.match(C.formatDate(Date.parse('2025-10-07T12:00:00Z'), NOW), /2025\/10\/7/);
  assert.equal(C.formatDate(null, NOW), '未取得');
});

test('key replacement/deletion purges previous account cache and backoff', async () => {
  const s = setup(); s.auth(); await s.ctl.loadProvider('opencodeGo');
  s.files.set('retry-opencodeGo', { until: NOW + 3600000 });
  assert.equal(s.ctl.saveGoKey(' synthetic-replacement '), true);
  assert.equal(s.keys.get(C.KEYS.go), 'synthetic-replacement');
  assert.equal(s.ctl.getCache('opencodeGo'), null);
  assert.equal(s.files.has('retry-opencodeGo'), false);
  assert.equal(s.ctl.saveGoKey(''), false);
  assert.equal(s.ctl.saveGoKey('two words'), false);
  s.ctl.deleteGoKey(); assert.equal(s.ctl.hasGoKey(), false);
  assert.equal(s.keys.has(C.KEYS.refresh), true);
  assert.equal(s.ctl.importCodexRefresh(' synthetic-reimport '), true);
  assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-reimport');
  assert.equal(s.keys.has(C.KEYS.access), false);
  assert.equal(s.keys.has(C.KEYS.account), false);
});

test('refresh settings default and validation', () => {
  const s = setup(); assert.equal(s.ctl.prefs().refreshMinutes, 15);
  assert.equal(s.ctl.saveRefreshMinutes(30), true); assert.equal(s.ctl.prefs().refreshMinutes, 30);
  assert.equal(s.ctl.saveRefreshMinutes(0), false); assert.equal(s.ctl.saveRefreshMinutes(1441), false);
  s.files.set('settings', { refreshMinutes: null }); assert.equal(s.ctl.prefs().refreshMinutes, 15);
});

test('cache and shared diagnostics contain no credentials, raw values, raw errors or unknown key names', async () => {
  const s = setup(); s.auth();
  const hostile = clone(fixtures.opencodeGo);
  hostile.usage.rolling['synthetic-sensitive-key-name'] = 'synthetic-sensitive-value';
  hostile.usage.rolling.status = 'synthetic-sensitive-status';
  hostile.access_token = 'synthetic-sensitive-token';
  s.env.http = async url => reply(url === C.URLS.go ? hostile : fixtures.codex);
  const results = await s.ctl.loadAll();
  const report = s.ctl.diagnosticReport(results);
  const stored = JSON.stringify([...s.files.values()]);
  for (const secret of ['synthetic-refresh', 'synthetic-go-key', 'synthetic-account', 'synthetic-sensitive', s.keys.get(C.KEYS.access)]) {
    assert.ok(!report.includes(secret)); assert.ok(!stored.includes(secret));
  }
  assert.match(report, /unknownFieldCount/);
  assert.match(report, /"httpStatus": 200/);
});

test('failed cache writes preserve current verified values but expose storage warning', async () => {
  const s = setup(); s.auth();
  s.env.writeJSON = () => { throw new Error('fixture storage unavailable'); };
  const result = await s.ctl.loadProvider('opencodeGo');
  assert.equal(result.status, 'ok'); assert.equal(result.errorCode, 'storage_error');
  assert.equal(result.windows[0].remainingPercent, 99);
  assert.equal(s.ctl.getCache('opencodeGo'), null);
});

// iOS API mocks exercise executed UI paths, not just the pure functions.
function uiSandbox({ inWidget = true, family = 'medium', screenWidth = 393, choices = [], secureValue = '', httpFailure = false,
    throwHTTPStatus = null, textValues = [] } = {}) {
  const rendered = [], texts = [], requests = [], files = new Map(), keys = new Map();
  const shownAlerts = [], openedURLs = [];
  let complete = 0, alertCount = 0;
  const warnings = [];
  class Node {
    addText(text) { texts.push(text); return {}; }
    addStack() { return new Node(); }
    addSpacer() {}
    addImage() { return {}; }
    layoutHorizontally() {} layoutVertically() {} topAlignContent() {}
    setPadding() {} async presentMedium() {}
  }
  class Alert {
    constructor() { alertCount++; }
    addAction() {} addCancelAction() {} addDestructiveAction() {}
    addSecureTextField() {} addTextField() {}
    textFieldValue() { return textValues.length ? textValues.shift() : secureValue; }
    async presentAlert() { shownAlerts.push({ title: this.title, message: this.message }); return choices.length ? choices.shift() : -1; }
    async presentSheet() { shownAlerts.push({ title: this.title, message: this.message }); return choices.length ? choices.shift() : -1; }
  }
  class Request {
    constructor(url) { this.url = url; requests.push(this); }
    async loadString() {
      if (httpFailure) throw new Error('synthetic-private-transport-error');
      if (throwHTTPStatus) {
        this.response = { statusCode: throwHTTPStatus, headers: {} };
        throw new Error('synthetic-private-http-error');
      }
      this.response = { statusCode: 200, headers: {} };
      return JSON.stringify(this.url === C.URLS.token ? {
        access_token: jwt(Date.now() / 1000 + 7200, 'synthetic-ui-account'), refresh_token: 'synthetic-ui-rotated',
      } : this.url === C.URLS.go ? fixtures.opencodeGo : fixtures.codex);
    }
  }
  class DrawContext { setFillColor() {} fillRect() {} getImage() { return {}; } }
  class Color { constructor(value) { this.value = value; } static dynamic(a) { return a; } }
  const fm = { libraryDirectory: () => '/fixture', joinPath: (a, b) => a + '/' + b,
    fileExists: name => files.has(name), createDirectory: name => files.set(name, null),
    readString: name => files.get(name), writeString: (name, value) => files.set(name, value), remove: name => files.delete(name) };
  const context = {
    config: { runsInWidget: inWidget, widgetFamily: family },
    Script: { name: () => 'AI Usage', setWidget: widget => rendered.push(widget), complete: () => { complete++; } },
    Keychain: { contains: key => keys.has(key), get: key => keys.get(key), set: (key, value) => keys.set(key, value), remove: key => keys.delete(key) },
    FileManager: { local: () => fm }, UUID: { string: () => 'fixture-ui-lock' },
    Data: { fromBase64String: value => ({ toRawString: () => Buffer.from(value, 'base64').toString('utf8') }) },
    Device: { screenSize: () => ({ width: screenWidth, height: 852 }) },
    Font: { systemFont: () => ({}), semiboldSystemFont: () => ({}) }, Color,
    ListWidget: Node, Alert, Request, DrawContext,
    Size: class { constructor(width, height) { this.width = width; this.height = height; } },
    Rect: class {}, QuickLook: { present: async value => warnings.push(value) },
    Safari: { openInApp: async url => openedURLs.push(url) },
  };
  const run = async () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(context), source)(...Object.values(context));
  };
  return { run, keys, files, rendered, texts, requests, warnings, shownAlerts, openedURLs,
    complete: () => complete, alerts: () => alertCount };
}

test('medium widget no auth renders safely without input dialogs', async () => {
  const s = uiSandbox(); await s.run();
  assert.equal(s.complete(), 1); assert.equal(s.alerts(), 0); assert.equal(s.requests.length, 0);
  assert.ok(s.texts.includes('Codex')); assert.ok(s.texts.includes('OpenCode Go'));
  assert.equal(s.texts.filter(text => text === '--%').length, 5);
});

test('small/large unsupported widget displays guidance and does not fetch', async () => {
  for (const family of ['small', 'large', 'accessoryRectangular']) {
    const s = uiSandbox({ family }); await s.run();
    assert.ok(s.texts.includes('中サイズで使用してください'));
    assert.equal(s.requests.length, 0); assert.equal(s.alerts(), 0); assert.equal(s.complete(), 1);
  }
});

test('configured widget renders all five rows at multiple device widths with secure direct transport', async () => {
  for (const width of [320, 375, 393, 430]) {
    const s = uiSandbox({ screenWidth: width });
    s.keys.set(C.KEYS.access, jwt(Date.now() / 1000 + 7200));
    s.keys.set(C.KEYS.refresh, 'synthetic-widget-refresh');
    s.keys.set(C.KEYS.account, 'synthetic-widget-account');
    s.keys.set(C.KEYS.go, 'synthetic-widget-key');
    await s.run();
    assert.equal(s.requests.length, 2);
    for (const request of s.requests) {
      assert.equal(request.timeoutInterval, 10);
      assert.equal(request.allowInsecureRequest, false);
      assert.equal(request.onRedirect({ url: 'https://fixture.example' }), null);
    }
    assert.ok(s.texts.includes('99%')); assert.ok(s.texts.includes('0%'));
    assert.ok(s.rendered[0].url.includes('AI%20Usage'));
    assert.equal(s.alerts(), 0); assert.equal(s.complete(), 1);
  }
});

test('in-app first setup saves secure input and manual update can preview without undefined functions', async () => {
  const s = uiSandbox({ inWidget: false, choices: [1, 0, 2, 0, -1], secureValue: 'synthetic-first-key' });
  await s.run();
  assert.equal(s.keys.get(C.KEYS.go), 'synthetic-first-key');
  assert.equal(s.requests.length, 2); assert.equal(s.complete(), 1);
  assert.ok(s.rendered.length >= 2);
});

test('in-app skipped setup, detail, diagnostic and settings exit are safe', async () => {
  const s = uiSandbox({ inWidget: false, choices: [2, 2, 4, 3, -1, -1] });
  await s.run();
  assert.equal(s.requests.length, 0); assert.equal(s.complete(), 1);
  assert.equal(s.warnings.length, 2);
  assert.match(s.warnings[0], /最終正常取得/);
  assert.match(s.warnings[1], /httpStatus/);
});

test('Scriptable throwing on HTTP failure still reports 403 instead of generic network failure', async () => {
  const s = uiSandbox({ inWidget: false, choices: [2, 4, -1], throwHTTPStatus: 403 });
  s.keys.set(C.KEYS.go, 'synthetic-http-error-key');
  await s.run();
  assert.match(s.warnings[0], /http_403/);
  assert.match(s.warnings[0], /"httpStatus": 403/);
  assert.ok(!s.warnings[0].includes('synthetic-private-http-error'));
});

test('in-app interval settings save and apply the requested refresh date', async () => {
  const s = uiSandbox({ inWidget: false, choices: [2, 3, 2, 0, -1], textValues: ['30'] });
  s.keys.set(C.KEYS.go, 'synthetic-settings-key');
  const before = Date.now();
  await s.run();
  assert.equal(JSON.parse(s.files.get('/fixture/AIUsage/settings.json')).refreshMinutes, 30);
  assert.ok(s.rendered.at(-1).refreshAfterDate.getTime() >= before + 30 * 60000);
  assert.equal(s.complete(), 1);
});

test('in-app key deletion confirms and clears only Go credentials', async () => {
  const s = uiSandbox({ inWidget: false, choices: [3, 1, 0, -1] });
  s.keys.set(C.KEYS.go, 'synthetic-delete-key');
  s.keys.set(C.KEYS.access, jwt(Date.now() / 1000 + 7200));
  s.keys.set(C.KEYS.account, 'synthetic-stay-account');
  await s.run();
  assert.equal(s.keys.has(C.KEYS.go), false);
  assert.equal(s.keys.get(C.KEYS.account), 'synthetic-stay-account');
  assert.equal(s.files.has('/fixture/AIUsage/cache-opencodeGo.json'), false);
  assert.equal(s.complete(), 1);
});

test('fresh controller detects missing Codex independently of Go key', () => {
  const s = setup();
  assert.equal(s.ctl.hasCodexAuth(), false);
  s.ctl.saveGoKey('synthetic-go-only');
  assert.equal(s.ctl.hasCodexAuth(), false);
  s.ctl.importCodexRefresh('synthetic-initial-refresh');
  assert.equal(s.ctl.hasCodexAuth(), true);
});

test('pasting an auth JSON document cannot replace saved credentials', () => {
  const s = setup(); s.auth();
  assert.equal(s.ctl.importCodexRefresh('{"tokens":{"refresh_token":"synthetic-json-token"}}'), false);
  assert.equal(s.ctl.importCodexRefresh('["synthetic-array-token"]'), false);
  assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-refresh');
  assert.equal(s.ctl.saveGoKey('{"key":"synthetic-json-key"}'), false);
  assert.equal(s.keys.get(C.KEYS.go), 'synthetic-go-key');
});

test('fresh in-app installation configures both providers without an old widget', async () => {
  const s = uiSandbox({ inWidget: false, choices: [0, 0, 0, 1, 0, 1, -1],
    textValues: ['synthetic-new-codex-refresh', 'synthetic-new-go-key'] });
  await s.run();
  assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-ui-rotated');
  assert.equal(s.keys.get(C.KEYS.account), 'synthetic-ui-account');
  assert.equal(s.keys.get(C.KEYS.go), 'synthetic-new-go-key');
  assert.equal(s.requests.length, 3);
  assert.equal(s.requests.filter(r => r.url === C.URLS.token).length, 1);
  assert.equal(s.requests.filter(r => r.url === C.URLS.codex).length, 1);
  assert.equal(s.requests.filter(r => r.url === C.URLS.go).length, 1);
  assert.ok(s.shownAlerts.some(a => a.title === 'Codexの初期設定'));
  assert.ok(s.shownAlerts.some(a => a.title === 'Codexの認証トークン'));
  assert.ok(s.texts.includes('99%')); assert.equal(s.complete(), 1);
});

test('closing initial setup makes no requests and preserves existing credentials', async () => {
  const s = uiSandbox({ inWidget: false, choices: [-1] });
  s.keys.set(C.KEYS.go, 'synthetic-preserved-go-key');
  await s.run();
  assert.equal(s.keys.get(C.KEYS.go), 'synthetic-preserved-go-key');
  assert.equal(s.requests.length, 0); assert.equal(s.complete(), 1);
  assert.equal(s.rendered.length, 0);
});

test('Codex first setup opens a public guide without sending credentials or fetching usage', async () => {
  const s = uiSandbox({ inWidget: false, choices: [0, 1, -1] });
  await s.run();
  assert.deepEqual(s.openedURLs, ['https://github.com/norei3510/ai-usage-widget/blob/main/SETUP.md']);
  assert.equal(s.requests.length, 0); assert.equal(s.keys.size, 0);
  assert.equal(s.complete(), 1);
});

test('canceling Codex secure input returns to setup and permits Go-only display', async () => {
  const s = uiSandbox({ inWidget: false, choices: [0, 0, -1, 2, -1] });
  s.keys.set(C.KEYS.go, 'synthetic-go-after-cancel');
  await s.run();
  assert.equal(s.keys.has(C.KEYS.refresh), false);
  assert.equal(s.requests.length, 1); assert.equal(s.requests[0].url, C.URLS.go);
  assert.equal(s.shownAlerts.filter(a => a.title === 'AI Usage 初期設定').length, 2);
  assert.equal(s.complete(), 1);
});

test('fully configured migration skips initial input and fetches both providers', async () => {
  const s = uiSandbox({ inWidget: false, choices: [-1] });
  s.keys.set(C.KEYS.access, jwt(Date.now() / 1000 + 7200));
  s.keys.set(C.KEYS.refresh, 'synthetic-migrated-refresh');
  s.keys.set(C.KEYS.account, 'synthetic-migrated-account');
  s.keys.set(C.KEYS.go, 'synthetic-migrated-go');
  await s.run();
  assert.equal(s.shownAlerts.length, 1); assert.equal(s.shownAlerts[0].title, 'AI Usage');
  assert.equal(s.requests.length, 2);
  assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-migrated-refresh');
});

test('Codex-only first setup completes, leaving Go visibly unconfigured', async () => {
  const s = uiSandbox({ inWidget: false, choices: [0, 0, 0, 2, -1], secureValue: 'synthetic-codex-only' });
  await s.run();
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests.some(r => r.url === C.URLS.go), false);
  assert.equal(s.texts.filter(t => t === '--%').length, 3);
  assert.ok(s.texts.includes('設定が必要'));
});

test('Codex can also be registered later from settings without any existing token', async () => {
  const s = uiSandbox({ inWidget: false, choices: [2, 3, 3, 0, 0, -1], secureValue: 'synthetic-settings-codex' });
  s.keys.set(C.KEYS.go, 'synthetic-existing-go');
  await s.run();
  assert.equal(s.keys.get(C.KEYS.refresh), 'synthetic-ui-rotated');
  assert.ok(s.texts.includes('99%'));
  assert.equal(s.complete(), 1);
});
