/** Pure parsing logic for Pi Quota Auto Continue; no network or credentials. */
const num = (x) => typeof x === 'number' && Number.isFinite(x) ? x : (typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null);
const object = (x) => x && typeof x === 'object' && !Array.isArray(x) ? x : null;

export function epochMs(value) {
  if (value == null) return null;
  const n = num(value);
  if (n !== null) {
    // Seconds, milliseconds; ignore nonsensical epochs.
    const ms = n < 1e11 ? n * 1000 : n;
    return ms > Date.UTC(2020, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
  }
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? date : null;
}

export function parseWindow(value, assumedType = null, now = Date.now()) {
  const w = object(value);
  if (!w) return null;
  const seconds = num(w.limit_window_seconds ?? w.limitWindowSeconds);
  const type = seconds !== null ? (seconds >= 172800 ? 'week' : '5h') : assumedType;
  if (!type) return null;
  const used = num(w.used_percent ?? w.usedPercent);
  const left = num(w.percent_left ?? w.percentLeft ?? w.remaining_percent);
  const usedPercent = used !== null ? used : left !== null ? 100 - left : null;
  const resetAfter = num(w.reset_after_seconds ?? w.resetAfterSeconds);
  const resetAt = epochMs(w.reset_time_ms ?? w.resetsAt ?? w.reset_at)
    ?? (resetAfter !== null && resetAfter >= 0 ? now + resetAfter * 1000 : null);
  const remaining = num(w.remaining ?? w.remaining_requests);
  return { type, seconds, usedPercent, resetAt, exhausted: (usedPercent !== null && usedPercent >= 99.999) || (remaining !== null && remaining <= 0) };
}

export function extractQuota(payload, modelId = '', now = Date.now()) {
  const root = object(payload);
  if (!root) return null;
  let rate = object(root.rate_limit ?? root.rate_limits);
  // Additional model-specific buckets take precedence when the name matches.
  const extras = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];
  const match = extras.find((item) => {
    const it = object(item);
    const label = String(it?.limit_name ?? it?.model ?? it?.name ?? '').toLowerCase();
    return !!modelId && !!label && (label === modelId.toLowerCase() || label.includes(modelId.toLowerCase()));
  });
  if (match) rate = object(match.rate_limit ?? match.rate_limits) ?? rate;
  if (!rate) return null;
  const slots = [
    [rate.five_hour ?? rate.primary_window ?? rate.primary, '5h'],
    [rate.weekly ?? rate.secondary_window ?? rate.secondary, 'week'],
  ];
  const windows = [];
  for (const [slot, expectedType] of slots) {
    const window = parseWindow(slot, expectedType, now);
    if (window) windows.push(window);
  }
  const isRateBlocked = rate.allowed === false || rate.limit_reached === true;
  const blocked = windows.filter((window) => window.exhausted);
  // No windows + allowed=true is not enough evidence to resume; the provider may omit model buckets.
  const available = !isRateBlocked && windows.length > 0 && blocked.length === 0;
  const resetTimes = blocked.map((w) => w.resetAt).filter((x) => x !== null);
  if (isRateBlocked && resetTimes.length === 0) {
    for (const w of windows) if (w.resetAt !== null) resetTimes.push(w.resetAt);
  }
  // Both windows must have cleared; the later reset is the useful time when both are empty.
  return { windows, blocked, available, isRateBlocked, nextResetAt: resetTimes.length ? Math.max(...resetTimes) : null };
}

export function isQuotaError(error) {
  const text = String(error ?? '');
  if (!text) return false;
  if (/insufficient[_ ]quota|insufficient[_ ]balance|billing|payment|monthly limit|model_not_in_plan|unauthorized|invalid[_ ]api[_ ]key|expired token|login required|subscription required|credit card/i.test(text)) return false;
  return /(?:\b429\b|rate[_ -]?limit[_ -]?(?:error|reached|exceeded)|usage[_ -]?limit|too many requests|quota exceeded|(?:5[ -]?hour|weekly|week|5h)[^\n]{0,80}(?:limit|reset|quota)|(?:limit|quota)[^\n]{0,80}(?:5[ -]?hour|weekly|week|5h))/i.test(text);
}

export function parseResetHint(error, now = Date.now()) {
  const text = String(error ?? '');
  const candidates = [];
  const abs = /(?:will\s+)?reset[s]?\s+(?:at|on)\s*[:：]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\s*(?:Z|[+-][0-9]{2}:?[0-9]{2}))?)/gi;
  for (const match of text.matchAll(abs)) {
    const at = epochMs(match[1].trim().replace(/^([0-9-]+) /, '$1T').replace(/\s+([+-][0-9]{2})/, '$1'));
    if (at !== null) candidates.push(at);
  }
  const rel = /(?:reset\s+after|retry\s+after|try\s+again\s+in)\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/gi;
  for (const match of text.matchAll(rel)) {
    const factor = /^d/i.test(match[2]) ? 86400000 : /^h/i.test(match[2]) ? 3600000 : /^m/i.test(match[2]) ? 60000 : 1000;
    candidates.push(now + Number(match[1]) * factor);
  }
  // When several quota windows are reported, resume only after the latest one.
  return candidates.length ? Math.max(...candidates) : null;
}

export function humanTime(ms) {
  return ms ? new Date(ms).toLocaleString() : 'unknown';
}
