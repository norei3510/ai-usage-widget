// AI Usage v1.1 — paste this entire file into Scriptable as "AI Usage".
// No credentials belong in this source. All credentials stay in Keychain.
// Setup guide updated: 2026-10-11. See README.md and VALIDATION.md.

const AIUsageCore = (() => {
  const VERSION = 1;
  const KEYS = Object.freeze({
    access: "codex-usage-widget.access-token",
    refresh: "codex-usage-widget.refresh-token",
    account: "codex-usage-widget.account-id",
    go: "ai-usage-widget.opencode-go-api-key",
  });
  const URLS = Object.freeze({
    codex: "https://chatgpt.com/backend-api/wham/usage",
    token: "https://auth.openai.com/oauth/token",
    go: "https://opencode.ai/zen/go/v1/usage",
  });
  const WINDOWS = Object.freeze({
    codex: [{ id: "fiveHour", label: "5時間" }, { id: "weekly", label: "週間" }],
    opencodeGo: [{ id: "fiveHour", label: "5時間" }, { id: "weekly", label: "週間" }, { id: "monthly", label: "月間" }],
  });
  const SAFE_CODES = new Set([
    "missing_auth", "missing_key", "auth_rejected", "refresh_busy", "storage_error",
    "network_error", "invalid_json", "invalid_schema", "no_valid_windows", "rate_limited",
    "http_401", "http_403", "http_429", "http_5xx", "http_other", "internal_error",
  ]);
  const GO_PERCENT = ["percent", "usagePercent", "usedPercent", "percentUsed", "usage_percent", "used_percent"];
  const GO_RELATIVE = ["resetInSec", "resetInSeconds", "resetSeconds", "reset_in_sec", "resetsInSec"];
  const GO_ISO = ["resetsAt", "resetAt", "resets_at", "reset_at"];
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const has = (obj, key) => object(obj) && Object.prototype.hasOwnProperty.call(obj, key);
  const number = value => typeof value === "number" && Number.isFinite(value);
  const timestamp = value => number(value) && value >= 0 && value <= 8640000000000000;
  const percent = value => number(value) && value >= 0 && value <= 100;
  const safeCode = code => SAFE_CODES.has(code) ? code : "internal_error";

  class UsageError extends Error {
    constructor(code, status = "fetchError", retryAfterAt = null) {
      super(safeCode(code));
      this.code = safeCode(code);
      this.state = status;
      this.retryAfterAt = retryAfterAt;
    }
  }

  function absoluteTime(value, unit) {
    let ms = null;
    if (unit === "seconds" && number(value)) ms = value * 1000;
    if (unit === "milliseconds" && number(value)) ms = value;
    if (unit === "iso" && typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      ms = Date.parse(value);
    }
    return timestamp(ms) ? ms : null;
  }

  function relativeTime(seconds, fetchedAt) {
    if (!number(seconds) || seconds < 0 || !timestamp(fetchedAt)) return null;
    return absoluteTime(fetchedAt + seconds * 1000, "milliseconds");
  }

  function blankWindows(provider) {
    return WINDOWS[provider].map(def => ({ ...def, usedPercent: null, remainingPercent: null,
      resetAt: null, status: "unavailable", resetStatus: "unknown" }));
  }

  function makeWindow(def, used, resetAt, invalidReset = false) {
    const valid = percent(used);
    return { ...def, usedPercent: valid ? used : null, remainingPercent: valid ? 100 - used : null,
      resetAt, status: valid ? "ok" : "unavailable",
      resetStatus: resetAt !== null ? "ok" : invalidReset ? "invalid" : "unknown" };
  }

  function codexReset(row, at) {
    if (has(row, "reset_at")) return { at: absoluteTime(row.reset_at, "seconds"), invalid: true };
    if (has(row, "reset_after_seconds")) return { at: relativeTime(row.reset_after_seconds, at), invalid: true };
    return { at: null, invalid: false };
  }

  function parseCodex(json, at) {
    if (!object(json) || !object(json.rate_limit)) throw new UsageError("invalid_schema", "parseError");
    const candidates = [json.rate_limit.primary_window, json.rate_limit.secondary_window].filter(object);
    const windows = WINDOWS.codex.map(def => {
      const seconds = def.id === "fiveHour" ? 18000 : 604800;
      const rows = candidates.filter(row => row.limit_window_seconds === seconds);
      // Do not assign quotas by primary/secondary position or guess an unknown duration.
      if (rows.length !== 1) return makeWindow(def, null, null);
      const reset = codexReset(rows[0], at);
      return makeWindow(def, rows[0].used_percent, reset.at, reset.invalid);
    });
    if (!windows.some(row => row.status === "ok")) throw new UsageError("no_valid_windows", "parseError");
    return windows;
  }

  function readGoPercent(row) {
    const fields = GO_PERCENT.filter(key => has(row, key));
    if (fields.length) {
      const values = fields.map(key => row[key]);
      // Direct API percent fields always mean 0..100, including 0 and 1.
      return values.every(percent) && values.every(value => value === values[0]) ? values[0] : null;
    }
    // Source-backed used/limit variant. No fraction-by-magnitude heuristic.
    const pairs = [["used", "limit"], ["usedTokens", "tokenLimit"], ["usedMicroCents", "limitMicroCents"]];
    for (const [usedKey, limitKey] of pairs) {
      if (has(row, usedKey) || has(row, limitKey)) {
        const used = row[usedKey], limit = row[limitKey];
        if (!number(used) || used < 0 || !number(limit) || limit <= 0) return null;
        const result = used / limit * 100;
        return percent(result) ? result : null;
      }
    }
    return null;
  }

  function goReset(row, at) {
    // API source emits ISO strings. Numeric timestamps with unspecified units are rejected.
    for (const key of GO_ISO) if (has(row, key)) return { at: absoluteTime(row[key], "iso"), invalid: true };
    for (const key of GO_RELATIVE) if (has(row, key)) return { at: relativeTime(row[key], at), invalid: true };
    return { at: null, invalid: false };
  }

  function parseGo(json, at) {
    if (!object(json) || !object(json.usage)) throw new UsageError("invalid_schema", "parseError");
    const apiNames = { fiveHour: "rolling", weekly: "weekly", monthly: "monthly" };
    const windows = WINDOWS.opencodeGo.map(def => {
      const row = json.usage[apiNames[def.id]];
      if (!object(row)) return makeWindow(def, null, null);
      const reset = goReset(row, at);
      const knownState = !has(row, "status") || ["ok", "rate-limited"].includes(row.status);
      return makeWindow(def, knownState ? readGoPercent(row) : null, reset.at, reset.invalid);
    });
    if (!windows.some(row => row.status === "ok")) throw new UsageError("no_valid_windows", "parseError");
    return windows;
  }

  function remainingColor(remaining) {
    return !percent(remaining) ? "gray" : remaining > 50 ? "green" : remaining > 20 ? "orange" : "red";
  }

  function normalizeCache(raw, provider, now) {
    if (!object(raw) || raw.version !== VERSION || raw.provider !== provider || raw.status !== "ok" ||
        !timestamp(raw.fetchedAt) || raw.fetchedAt > now + 60000 || !timestamp(raw.lastAttemptAt) ||
        !Array.isArray(raw.windows) || raw.windows.length !== WINDOWS[provider].length) return null;
    const windows = [];
    for (const def of WINDOWS[provider]) {
      const matches = raw.windows.filter(row => object(row) && row.id === def.id);
      if (matches.length !== 1) return null;
      const row = matches[0];
      if (!["ok", "unavailable"].includes(row.status) || !["ok", "unknown", "invalid"].includes(row.resetStatus) ||
          !(row.resetAt === null || timestamp(row.resetAt)) ||
          (row.resetStatus === "ok") !== (row.resetAt !== null)) return null;
      if (row.status === "ok" && (!percent(row.usedPercent) || !percent(row.remainingPercent) ||
          Math.abs(row.remainingPercent - (100 - row.usedPercent)) > 1e-8)) return null;
      if (row.status === "unavailable" && (row.usedPercent !== null || row.remainingPercent !== null)) return null;
      // Rebuild rather than spreading input: cache cannot retain extra fields or secrets.
      windows.push({ ...def, usedPercent: row.usedPercent, remainingPercent: row.remainingPercent,
        resetAt: row.resetAt, status: row.status, resetStatus: row.resetStatus });
    }
    if (!windows.some(row => row.status === "ok")) return null;
    return { version: VERSION, provider, status: "ok", fetchedAt: raw.fetchedAt,
      lastAttemptAt: raw.lastAttemptAt, windows, errorCode: null };
  }

  function failedResult(provider, previous, at, error) {
    const state = error instanceof UsageError ? error.state : "fetchError";
    return { provider, status: previous && state === "fetchError" ? "stale" : state,
      fetchedAt: previous ? previous.fetchedAt : null, lastAttemptAt: at,
      windows: previous ? previous.windows : blankWindows(provider),
      errorCode: safeCode(error.code), retryAfterAt: error.retryAfterAt || null };
  }

  function retryAfter(value, at) {
    if (typeof value !== "string") return at + 15 * 60000;
    const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : null;
    const date = seconds === null ? Date.parse(value) : at + seconds * 1000;
    return timestamp(date) && date > at ? date : at + 15 * 60000;
  }

  function httpError(status, headers, at, tokenRequest) {
    if (status === 429) {
      const key = Object.keys(headers || {}).find(key => key.toLowerCase() === "retry-after");
      return new UsageError("http_429", "fetchError", retryAfter(key ? String(headers[key]) : null, at));
    }
    if (status === 401) return new UsageError("http_401", "authError");
    if (status === 403) return new UsageError("http_403", "authError");
    if (tokenRequest && status === 400) return new UsageError("auth_rejected", "authError");
    return new UsageError(status >= 500 ? "http_5xx" : "http_other");
  }

  function decodeToken(token, decoder) {
    try {
      if (typeof token !== "string") return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (encoded.length % 4) encoded += "=";
      const result = JSON.parse(decoder(encoded));
      return object(result) ? result : null;
    } catch (_) { return null; }
  }

  function accountFromToken(token, decoder) {
    const payload = decodeToken(token, decoder);
    const auth = payload && object(payload["https://api.openai.com/auth"]) ? payload["https://api.openai.com/auth"] : {};
    const account = auth.chatgpt_account_id || auth.account_id || (payload && (payload.chatgpt_account_id || payload.account_id));
    return typeof account === "string" && account.length > 0 ? account : "";
  }

  function expiresSoon(token, decoder, now) {
    const payload = decodeToken(token, decoder);
    return !payload || !number(payload.exp) || payload.exp * 1000 - now <= 5 * 60000;
  }

  function typeOf(value) {
    return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  }

  function diagnosticShape(json, provider) {
    // Never include response values, arbitrary key names, headers, account IDs or tokens.
    const rows = { root: typeOf(json) };
    const root = provider === "codex" ? "rate_limit" : "usage";
    rows[root] = typeOf(object(json) ? json[root] : undefined);
    const names = provider === "codex" ? ["primary_window", "secondary_window"] : ["rolling", "weekly", "monthly"];
    const allowed = provider === "codex" ? ["limit_window_seconds", "used_percent", "reset_at", "reset_after_seconds"] :
      ["status", ...GO_PERCENT, ...GO_RELATIVE, ...GO_ISO, "used", "limit", "usedTokens", "tokenLimit", "usedMicroCents", "limitMicroCents"];
    for (const name of names) {
      const row = object(json) && object(json[root]) ? json[root][name] : undefined;
      rows[root + "." + name] = typeOf(row);
      if (!object(row)) continue;
      for (const field of allowed) if (has(row, field)) rows[root + "." + name + "." + field] = typeOf(row[field]);
      rows[root + "." + name + ".unknownFieldCount"] = Object.keys(row).filter(key => !allowed.includes(key)).length;
    }
    return rows;
  }

  function createController(env) {
    const diagnostics = {};
    const read = name => { try { return env.readJSON(name); } catch (_) { return null; } };
    const write = (name, value) => { try { env.writeJSON(name, value); return true; } catch (_) { return false; } };
    const keyGet = key => env.keychain.contains(key) ? env.keychain.get(key) : "";
    const credentials = () => ({ access: keyGet(KEYS.access), refresh: keyGet(KEYS.refresh), account: keyGet(KEYS.account) });
    const getCache = provider => normalizeCache(read("cache-" + provider), provider, env.now());

    function prefs() {
      const raw = read("settings");
      const minutes = object(raw) && number(raw.refreshMinutes) && raw.refreshMinutes >= 5 && raw.refreshMinutes <= 1440 ? raw.refreshMinutes : 15;
      return { refreshMinutes: minutes };
    }

    function throttle(provider) {
      const raw = read("retry-" + provider);
      return object(raw) && timestamp(raw.until) && raw.until > env.now() ? raw.until : null;
    }

    async function request(url, options, provider, tokenRequest = false) {
      let response;
      try { response = await env.http(url, options); }
      catch (_) {
        diagnostics[provider] = { stage: tokenRequest ? "token" : "usage", httpStatus: null, errorCode: "network_error" };
        throw new UsageError("network_error");
      }
      diagnostics[provider] = { stage: tokenRequest ? "token" : "usage", httpStatus: response.status, errorCode: null };
      if (response.status !== 200) throw httpError(response.status, response.headers, env.now(), tokenRequest);
      let json;
      try { json = JSON.parse(response.body); }
      catch (_) { throw new UsageError("invalid_json", "parseError"); }
      if (!tokenRequest) diagnostics[provider].structure = diagnosticShape(json, provider);
      return json;
    }

    async function refreshCodex(force, failedAccess = null) {
      const first = credentials();
      if (!force && !expiresSoon(first.access, env.decodeBase64, env.now())) return first;
      // If another execution has already replaced the rejected access token, reuse it.
      if (force && first.access && first.access !== failedAccess && !expiresSoon(first.access, env.decodeBase64, env.now())) return first;
      if (!first.refresh) throw new UsageError("missing_auth", "unconfigured");
      const now = env.now();
      const lock = read("refresh-lock");
      if (object(lock) && timestamp(lock.expiresAt) && lock.expiresAt > now && lock.expiresAt <= now + 60000) {
        throw new UsageError("refresh_busy");
      }
      const owner = env.newID();
      if (!write("refresh-lock", { owner, expiresAt: now + 60000 })) throw new UsageError("storage_error");
      const claimed = read("refresh-lock");
      if (!claimed || claimed.owner !== owner) throw new UsageError("refresh_busy");
      try {
        const latest = credentials();
        if (latest.access && latest.access !== first.access && !expiresSoon(latest.access, env.decodeBase64, env.now())) return latest;
        if (!latest.refresh) throw new UsageError("missing_auth", "unconfigured");
        let json;
        try {
          json = await request(URLS.token, {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(latest.refresh) +
              "&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
          }, "codex", true);
        } catch (error) {
          const changed = credentials();
          if (changed.access && changed.access !== latest.access && !expiresSoon(changed.access, env.decodeBase64, env.now())) return changed;
          throw error;
        }
        if (!object(json) || typeof json.access_token !== "string" || !json.access_token ||
            (has(json, "refresh_token") && (typeof json.refresh_token !== "string" || !json.refresh_token))) {
          throw new UsageError("invalid_schema", "parseError");
        }
        // Save rotated refresh token first, before any parsing or further I/O.
        const rotated = json.refresh_token || latest.refresh;
        env.keychain.set(KEYS.refresh, rotated);
        env.keychain.set(KEYS.access, json.access_token);
        const account = accountFromToken(json.access_token, env.decodeBase64) || latest.account;
        if (account) env.keychain.set(KEYS.account, account);
        return { access: json.access_token, refresh: rotated, account };
      } finally {
        const current = read("refresh-lock");
        if (current && current.owner === owner) write("refresh-lock", { owner: "", expiresAt: 0 });
      }
    }

    async function fetchCodex() {
      let auth = credentials();
      if (!auth.access && !auth.refresh) throw new UsageError("missing_auth", "unconfigured");
      if (expiresSoon(auth.access, env.decodeBase64, env.now())) auth = await refreshCodex(false);
      const get = async bundle => {
        const account = bundle.account || accountFromToken(bundle.access, env.decodeBase64);
        if (!account) throw new UsageError("missing_auth", "authError");
        if (!bundle.account) env.keychain.set(KEYS.account, account);
        return await request(URLS.codex, { method: "GET", headers: {
          Authorization: "Bearer " + bundle.access, "ChatGPT-Account-Id": account, Accept: "application/json",
        } }, "codex");
      };
      try { return await get(auth); }
      catch (error) {
        if (error.code !== "http_401") throw error;
        auth = await refreshCodex(true, auth.access);
        return await get(auth); // Exactly one retry; its failure propagates.
      }
    }

    async function fetchGo() {
      const key = keyGet(KEYS.go);
      if (!key) throw new UsageError("missing_key", "unconfigured");
      return await request(URLS.go, { method: "GET", headers: { Authorization: "Bearer " + key, Accept: "application/json" } }, "opencodeGo");
    }

    async function loadProvider(provider) {
      const attemptAt = env.now();
      const previous = getCache(provider);
      try {
        const until = throttle(provider);
        if (until) throw new UsageError("rate_limited", "fetchError", until);
        const json = provider === "codex" ? await fetchCodex() : await fetchGo();
        const fetchedAt = env.now();
        const windows = provider === "codex" ? parseCodex(json, fetchedAt) : parseGo(json, fetchedAt);
        const result = { version: VERSION, provider, status: "ok", fetchedAt, lastAttemptAt: attemptAt, windows, errorCode: null };
        if (!write("cache-" + provider, normalizeCache(result, provider, env.now()))) result.errorCode = "storage_error";
        write("retry-" + provider, { until: 0 });
        return result;
      } catch (error) {
        const safe = error instanceof UsageError ? error : new UsageError("internal_error");
        if (safe.retryAfterAt) write("retry-" + provider, { until: safe.retryAfterAt });
        const diagnostic = diagnostics[provider] || { stage: "local", httpStatus: null };
        diagnostics[provider] = { ...diagnostic, errorCode: safe.code };
        return failedResult(provider, previous, attemptAt, safe);
      }
    }

    async function loadAll() {
      const results = await Promise.all([loadProvider("codex"), loadProvider("opencodeGo")]);
      return { codex: results[0], opencodeGo: results[1] };
    }

    function saveGoKey(key) {
      if (typeof key !== "string" || !key.trim() || /\s/.test(key.trim()) || /^[\[{\"]/.test(key.trim())) return false;
      env.keychain.set(KEYS.go, key.trim());
      clearProvider("opencodeGo");
      return true;
    }

    function clearProvider(provider) {
      // Clear previous account's data and backoff after credentials are changed/deleted.
      env.removeFile("cache-" + provider);
      env.removeFile("retry-" + provider);
      delete diagnostics[provider];
    }

    function deleteGoKey() {
      if (env.keychain.contains(KEYS.go)) env.keychain.remove(KEYS.go);
      clearProvider("opencodeGo");
    }

    function importCodexRefresh(token) {
      if (typeof token !== "string" || !token.trim() || /\s/.test(token.trim()) || /^[\[{\"]/.test(token.trim())) return false;
      env.keychain.set(KEYS.refresh, token.trim());
      for (const key of [KEYS.access, KEYS.account]) if (env.keychain.contains(key)) env.keychain.remove(key);
      clearProvider("codex");
      return true;
    }

    function saveRefreshMinutes(minutes) {
      if (!number(minutes) || minutes < 5 || minutes > 1440) return false;
      return write("settings", { refreshMinutes: minutes });
    }

    function diagnosticReport(results) {
      const report = { version: VERSION, generatedAt: new Date(env.now()).toISOString(), providers: {} };
      for (const provider of Object.keys(WINDOWS)) {
        const result = results[provider];
        report.providers[provider] = { status: result.status, errorCode: result.errorCode,
          windows: result.windows.map(row => ({ id: row.id, status: row.status, resetStatus: row.resetStatus })),
          transport: diagnostics[provider] || { stage: "local", httpStatus: null } };
      }
      return JSON.stringify(report, null, 2);
    }

    return { prefs, getCache, loadProvider, loadAll,
      hasCodexAuth: () => !!(keyGet(KEYS.refresh) || keyGet(KEYS.access)), hasGoKey: () => !!keyGet(KEYS.go),
      saveGoKey, deleteGoKey, importCodexRefresh, saveRefreshMinutes, diagnosticReport };
  }

  const pad = value => String(value).padStart(2, "0");
  const clock = date => pad(date.getHours()) + ":" + pad(date.getMinutes());
  const day = date => (date.getMonth() + 1) + "/" + date.getDate();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function formatDate(at, now) {
    if (!timestamp(at)) return "未取得";
    const value = new Date(at), today = new Date(now);
    const prefix = value.getFullYear() !== today.getFullYear() ? value.getFullYear() + "/" : "";
    return sameDay(value, today) ? clock(value) : prefix + day(value) + " " + clock(value);
  }
  function formatReset(at, now, detailed = false) {
    if (!timestamp(at)) return "リセット不明";
    if (at <= now) return detailed ? "リセット時刻経過・要更新（" + formatDate(at, now) + "）" : "時刻経過・要更新";
    const label = "↻ " + formatDate(at, now);
    if (!detailed) return label;
    const minutes = Math.ceil((at - now) / 60000);
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    return label + "（あと" + (days ? days + "日 " : "") + hours + "時間 " + rest + "分）";
  }
  function isOld(result, now) { return result.fetchedAt !== null && now - result.fetchedAt >= 30 * 60000; }
  function providerState(result, now) {
    let label = "正常";
    if (result.status === "unconfigured") label = "設定が必要";
    else if (result.errorCode === "http_403") label = "権限・契約を確認";
    else if (result.status === "authError") label = "再認証が必要";
    else if (result.errorCode === "refresh_busy") label = "更新中";
    else if (["rate_limited", "http_429"].includes(result.errorCode)) label = "取得制限";
    else if (result.status !== "ok") label = "取得失敗";
    else if (result.errorCode === "storage_error") label = "保存失敗";
    else if (result.windows.some(row => row.status !== "ok" || row.resetStatus !== "ok")) label = "一部取得不可";
    if (result.status !== "ok" && result.fetchedAt !== null) label += "・前回値";
    if (isOld(result, now)) label += "・古いデータ";
    return label;
  }

  return { VERSION, KEYS, URLS, WINDOWS, UsageError, absoluteTime, relativeTime, blankWindows,
    parseCodex, parseGo, remainingColor, normalizeCache, failedResult, retryAfter, httpError,
    decodeToken, accountFromToken, expiresSoon, diagnosticShape, createController,
    formatDate, formatReset, isOld, providerState };
})();

function scriptableEnvironment() {
  const fm = FileManager.local();
  const directory = fm.joinPath(fm.libraryDirectory(), "AIUsage");
  if (!fm.fileExists(directory)) fm.createDirectory(directory, true);
  const path = name => fm.joinPath(directory, name + ".json");
  return {
    now: () => Date.now(), newID: () => UUID.string(), keychain: Keychain,
    decodeBase64: encoded => Data.fromBase64String(encoded).toRawString(),
    readJSON: name => fm.fileExists(path(name)) ? JSON.parse(fm.readString(path(name))) : null,
    writeJSON: (name, value) => fm.writeString(path(name), JSON.stringify(value)),
    removeFile: name => { if (fm.fileExists(path(name))) fm.remove(path(name)); },
    http: async (url, options) => {
      const request = new Request(url);
      request.method = options.method;
      request.headers = options.headers;
      if (options.body) request.body = options.body;
      request.timeoutInterval = 10;
      request.allowInsecureRequest = false;
      // Neither usage nor token calls require redirects. Reject all to protect credentials.
      request.onRedirect = () => null;
      let body;
      try { body = await request.loadString(); }
      catch (error) {
        // Some platforms throw on HTTP failures; still retain the HTTP category,
        // never the exception text or response body.
        const status = request.response && request.response.statusCode;
        if (status && status !== 200) return { status, headers: request.response.headers || {}, body: "" };
        throw error;
      }
      return { status: request.response ? request.response.statusCode : 0,
        headers: request.response ? request.response.headers : {}, body };
    },
  };
}

function uiColor(name) {
  const colors = { green: "30A46C", orange: "D88718", red: "D94444", gray: "8E8E93" };
  return new Color(colors[name] || colors.gray);
}

function uiText(parent, text, size, strong = false, color = null) {
  const node = parent.addText(text);
  node.font = strong ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  node.textColor = color || Color.dynamic(new Color("202124"), new Color("F2F2F7"));
  node.lineLimit = 1;
  node.minimumScaleFactor = 0.75;
  return node;
}

function drawBar(remaining, width) {
  const canvas = new DrawContext();
  canvas.size = new Size(width, 3);
  canvas.opaque = false;
  canvas.respectScreenScale = true;
  canvas.setFillColor(Color.dynamic(new Color("DADCE0"), new Color("414148")));
  canvas.fillRect(new Rect(0, 0, width, 3));
  if (typeof remaining === "number" && remaining > 0) {
    canvas.setFillColor(uiColor(AIUsageCore.remainingColor(remaining)));
    canvas.fillRect(new Rect(0, 0, width * remaining / 100, 3));
  }
  return canvas.getImage();
}

function createWidget(results, minutes, family = "medium") {
  const now = Date.now();
  const widget = new ListWidget();
  widget.backgroundColor = Color.dynamic(new Color("F5F5F7"), new Color("1C1C1E"));
  widget.setPadding(8, 10, 8, 10);
  widget.refreshAfterDate = new Date(now + minutes * 60000);
  widget.url = "scriptable:///run?scriptName=" + encodeURIComponent(Script.name());
  if (family !== "medium") {
    uiText(widget, "AI Usage", 14, true);
    widget.addSpacer(8);
    uiText(widget, "中サイズで使用してください", 11);
    return widget;
  }
  const header = widget.addStack();
  header.layoutHorizontally();
  uiText(header, "AI Usage", 12, true);
  header.addSpacer();
  uiText(header, "残量", 10, false, uiColor("gray"));
  widget.addSpacer(4);
  const columns = widget.addStack();
  columns.layoutHorizontally();
  columns.topAlignContent();
  const screen = Device.screenSize();
  // Conservative, device-relative width leaves space for iOS widget margins.
  // No fixed 145pt columns; smallest iPhone gets proportionally narrower columns.
  const columnWidth = Math.max(90, Math.floor((Math.min(screen.width, screen.height) - 110) / 2));
  for (const provider of ["codex", "opencodeGo"]) {
    if (provider === "opencodeGo") columns.addSpacer();
    const column = columns.addStack();
    column.layoutVertically();
    column.size = new Size(columnWidth, 0);
    const result = results[provider];
    uiText(column, provider === "codex" ? "Codex" : "OpenCode Go", 10, true);
    column.addSpacer(3);
    for (let index = 0; index < 3; index++) {
      const row = result.windows[index];
      if (!row) { column.addSpacer(27); continue; }
      const heading = column.addStack();
      heading.layoutHorizontally();
      uiText(heading, row.label, 9);
      heading.addSpacer();
      uiText(heading, row.status === "ok" ? Math.round(row.remainingPercent) + "%" : "--%", 10, true,
        uiColor(AIUsageCore.remainingColor(row.remainingPercent)));
      column.addSpacer(1);
      const bar = column.addImage(drawBar(row.remainingPercent, columnWidth));
      bar.imageSize = new Size(columnWidth, 3);
      column.addSpacer(1);
      uiText(column, row.status !== "ok" ? "取得不可" : AIUsageCore.formatReset(row.resetAt, now), 8, false, uiColor("gray"));
      if (index < 2) column.addSpacer(3);
    }
    column.addSpacer(3);
    const state = AIUsageCore.providerState(result, now);
    uiText(column, state, 7, false, uiColor(state === "正常" ? "gray" : "orange"));
    uiText(column, "取得 " + AIUsageCore.formatDate(result.fetchedAt, now), 7, false, uiColor("gray"));
  }
  return widget;
}

async function showMessage(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("OK");
  await alert.presentAlert();
}

async function enterSecret(controller, codex = false) {
  const alert = new Alert();
  alert.title = codex ? "Codexの認証トークン" : "OpenCode GoのAPIキー";
  alert.message = codex ? "PCで作成したウィジェット専用ログインのrefresh tokenだけを入力します。auth.json全体は入力しません。入力はこのiPhoneのKeychainに保存します。" :
    "キーはこのiPhoneのKeychainに保存します。チャットへの送信は不要です。";
  alert.addSecureTextField(codex ? "refresh token" : "APIキー", "");
  alert.addAction("保存");
  alert.addCancelAction("キャンセル");
  if (await alert.presentAlert() < 0) return false;
  const value = alert.textFieldValue(0);
  const saved = codex ? controller.importCodexRefresh(value) : controller.saveGoKey(value);
  if (!saved) await showMessage("保存できません", "空欄・途中の空白・JSON全文を確認してください。キーまたはrefresh tokenの文字列だけを入力します。");
  return saved;
}

async function configureCodex(controller) {
  const guide = new Alert();
  guide.title = controller.hasCodexAuth() ? "Codex認証を差し替え" : "Codexの初期設定";
  guide.message = controller.hasCodexAuth() ?
    "保存済み認証を新しいウィジェット専用ログインに置き換えます。別のCodexウィジェットで同じ認証を使用している場合は、その実行を止めてください。" :
    "初回だけPCでCodex CLIを使って専用ログインを作成します。旧ウィジェットの導入は不要です。手順に沿ってrefresh tokenを用意し、このiPhoneへ入力してください。設定後の日常利用はiPhoneだけでできます。";
  guide.addAction("用意したトークンを入力");
  guide.addAction("認証の作成手順を開く");
  guide.addCancelAction("戻る");
  const choice = await guide.presentSheet();
  if (choice === 0) return await enterSecret(controller, true);
  if (choice === 1) await Safari.openInApp("https://github.com/norei3510/ai-usage-widget/blob/main/SETUP.md", false);
  return false;
}

async function initialSetup(controller) {
  // This function is reached only in the app, never by a Home Screen widget.
  while (true) {
    const codex = controller.hasCodexAuth(), go = controller.hasGoKey();
    if (codex && go) return true;
    const setup = new Alert();
    setup.title = "AI Usage 初期設定";
    setup.message = "Codex: " + (codex ? "保存済み" : "未設定") + "\nOpenCode Go: " + (go ? "保存済み" : "未設定") +
      "\n\nCodexはPCで1回だけ認証を作成します。OpenCode Goは契約先で発行したAPIキーを入力します。片方だけでも表示を始められます。";
    setup.addAction(codex ? "Codexは保存済み・設定を確認" : "Codexを設定");
    setup.addAction(go ? "OpenCode Goは保存済み・設定を確認" : "OpenCode Goを設定");
    setup.addAction("この状態で続ける");
    setup.addCancelAction("閉じる");
    const choice = await setup.presentSheet();
    if (choice < 0) return false;
    if (choice === 2) return true;
    if (choice === 0) {
      if (codex) await showMessage("Codexは保存済み", "このまま続けると保存済み認証で取得します。認証の差替えは「設定」から行えます。");
      else await configureCodex(controller);
    }
    if (choice === 1) {
      if (go) await showMessage("OpenCode Goは保存済み", "このまま続けると保存済みキーで取得します。キーの差替えは「設定」から行えます。");
      else await enterSecret(controller);
    }
  }
}

async function settingsMenu(controller) {
  const alert = new Alert();
  alert.title = "AI Usage 設定";
  alert.addAction("OpenCode Goキーを登録・差替え");
  alert.addDestructiveAction("OpenCode Goキーを削除");
  alert.addAction("更新要求の間隔を変更");
  alert.addAction("Codex認証を登録・差替え");
  alert.addAction("初期設定を開く");
  alert.addCancelAction("戻る");
  const choice = await alert.presentSheet();
  if (choice === 0) await enterSecret(controller);
  if (choice === 1) {
    const confirm = new Alert();
    confirm.title = "OpenCode Goキーを削除";
    confirm.message = "保存済みキーとOpenCode Goの前回値をこのiPhoneから削除します。サービス側のキーは失効しません。";
    confirm.addDestructiveAction("削除"); confirm.addCancelAction("キャンセル");
    if (await confirm.presentAlert() === 0) controller.deleteGoKey();
  }
  if (choice === 2) {
    const interval = new Alert(); interval.title = "更新要求の間隔";
    interval.message = "5～1440分。初期値15分。実際の更新時刻はiOSが決めます。";
    interval.addTextField("分", String(controller.prefs().refreshMinutes));
    interval.addAction("保存"); interval.addCancelAction("キャンセル");
    if (await interval.presentAlert() === 0) {
      const input = interval.textFieldValue(0).trim();
      if (!/^\d+$/.test(input) || !controller.saveRefreshMinutes(Number(input))) {
        await showMessage("保存できません", "5～1440の整数を入力してください。保存領域が使用できない場合も保存できません。");
      }
    }
  }
  if (choice === 3) await configureCodex(controller);
  if (choice === 4) await initialSetup(controller);
}

function detailText(results) {
  const now = Date.now();
  const lines = ["AI Usage — 残量", ""];
  for (const provider of ["codex", "opencodeGo"]) {
    const result = results[provider];
    lines.push(provider === "codex" ? "Codex" : "OpenCode Go", AIUsageCore.providerState(result, now),
      "最終正常取得: " + AIUsageCore.formatDate(result.fetchedAt, now),
      "最終試行: " + AIUsageCore.formatDate(result.lastAttemptAt, now));
    if (result.errorCode) lines.push("エラー: " + result.errorCode);
    if (result.retryAfterAt) lines.push("再取得可能: " + AIUsageCore.formatDate(result.retryAfterAt, now));
    for (const row of result.windows) lines.push(row.label + ": " +
      (row.status === "ok" ? Math.round(row.remainingPercent) + "% 残量" : "取得不可"),
      AIUsageCore.formatReset(row.resetAt, now, true));
    lines.push("");
  }
  lines.push("ホーム画面の更新はiOSが制御します。手動更新後の即時反映は保証されません。");
  return lines.join("\n");
}

async function main() {
  try {
    const controller = AIUsageCore.createController(scriptableEnvironment());
    if (config.runsInWidget) {
      if (config.widgetFamily !== "medium") {
        Script.setWidget(createWidget(null, controller.prefs().refreshMinutes, config.widgetFamily));
      } else {
        const results = await controller.loadAll();
        Script.setWidget(createWidget(results, controller.prefs().refreshMinutes));
      }
    } else {
      if ((!controller.hasCodexAuth() || !controller.hasGoKey()) && !await initialSetup(controller)) return;
      let results = await controller.loadAll();
      Script.setWidget(createWidget(results, controller.prefs().refreshMinutes));
      let active = true;
      while (active) {
        const menu = new Alert(); menu.title = "AI Usage";
        menu.message = "Codex: " + AIUsageCore.providerState(results.codex, Date.now()) + "\nOpenCode Go: " +
          AIUsageCore.providerState(results.opencodeGo, Date.now());
        menu.addAction("最新値を取得してプレビュー");
        menu.addAction("取得済みの中サイズプレビュー");
        menu.addAction("詳細・エラーを見る");
        menu.addAction("設定");
        menu.addAction("共有用診断を見る");
        menu.addCancelAction("終了");
        const choice = await menu.presentSheet();
        if (choice === 0) results = await controller.loadAll();
        if (choice === 0 || choice === 1) {
          const widget = createWidget(results, controller.prefs().refreshMinutes);
          Script.setWidget(widget); await widget.presentMedium();
        }
        if (choice === 2) await QuickLook.present(detailText(results));
        if (choice === 3) {
          await settingsMenu(controller);
          results = await controller.loadAll();
          Script.setWidget(createWidget(results, controller.prefs().refreshMinutes));
        }
        if (choice === 4) await QuickLook.present(controller.diagnosticReport(results));
        if (choice < 0) active = false;
      }
    }
  } catch (_) {
    // Never display exception messages: a dependency may include credentials in them.
    const widget = new ListWidget(); widget.setPadding(12, 12, 12, 12);
    uiText(widget, "AI Usage", 14, true); widget.addSpacer(6);
    uiText(widget, "実行できません", 11);
    uiText(widget, "Scriptableの保存領域を確認", 9);
    widget.refreshAfterDate = new Date(Date.now() + 15 * 60000);
    Script.setWidget(widget);
    if (!config.runsInWidget) await showMessage("AI Usage", "実行できません。Scriptableの保存領域・Keychainを確認してください。認証情報は自動削除していません。");
  } finally { Script.complete(); }
}

// SCRIPTABLE ENTRY — tests load the declarations above without executing iOS UI.
await main();
