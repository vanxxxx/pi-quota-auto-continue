import test from 'node:test';
import assert from 'node:assert/strict';
import { extractQuota, extractClaudeQuota, isQuotaError, parseResetHint } from '../src/quota-core.mjs';

const NOW = Date.UTC(2026, 9, 23, 2, 0, 0);
const h5 = (used, at = NOW + 3_600_000) => ({ used_percent: used, reset_at: at / 1000, limit_window_seconds: 18000 });
const week = (used, at = NOW + 10 * 3_600_000) => ({ used_percent: used, reset_at: at / 1000, limit_window_seconds: 604800 });

test('maps windows by duration rather than field name', () => {
  const q = extractQuota({ rate_limit: { primary_window: week(100), secondary_window: h5(20) } }, '', NOW);
  assert.equal(q.windows.find(x => x.type === 'week').exhausted, true);
  assert.equal(q.windows.find(x => x.type === '5h').exhausted, false);
  assert.equal(q.nextResetAt, NOW + 10 * 3_600_000);
  assert.equal(q.available, false);
});

test('waits for BOTH windows to be available', () => {
  const q = extractQuota({ rate_limit: { allowed: false, primary_window: h5(100), secondary_window: week(100) } }, '', NOW);
  assert.equal(q.nextResetAt, NOW + 10 * 3_600_000);
  assert.equal(q.available, false);
  assert.equal(extractQuota({ rate_limit: { allowed: true, primary_window: h5(25), secondary_window: week(92) } }, '', NOW).available, true);
});

test('handles single weekly window and no windows safely', () => {
  assert.deepEqual(extractQuota({ rate_limit: { primary_window: week(45), secondary_window: null } }, '', NOW).windows.map(x => x.type), ['week']);
  assert.equal(extractQuota({ rate_limit: { allowed: true, primary_window: null } }, '', NOW).available, false);
});

test('prefers matched additional model bucket', () => {
  const q = extractQuota({ rate_limit: { primary_window: h5(20) }, additional_rate_limits: [{ limit_name: 'gpt-5.4', rate_limit: { primary_window: h5(100) } }] }, 'gpt-5.4', NOW);
  assert.equal(q.available, false);
});

test('detects quota errors but not billing or auth errors', () => {
  assert.equal(isQuotaError('429: usage_limit_reached'), true);
  assert.equal(isQuotaError('Usage limit reached for 5 hour. Your limit will reset at 2026-10-23 17:11:22'), true);
  assert.equal(isQuotaError('insufficient_quota 429'), false);
  assert.equal(isQuotaError('MODEL_NOT_IN_PLAN (429)'), false);
  assert.equal(isQuotaError('Connection error'), false);
});

test('recognizes relative and absolute reset hints', () => {
  assert.equal(parseResetHint('Rate limit 429 (reset after 8s)', NOW), NOW + 8000);
  assert.equal(parseResetHint('retry after 3 minutes', NOW), NOW + 180000);
  assert.equal(parseResetHint('reset at 2026-10-23 17:11:22+08:00', NOW), Date.parse('2026-10-23T17:11:22+08:00'));
  assert.equal(parseResetHint('5h resets at 2026-10-23 14:00:00+08:00; week resets at 2026-10-24 20:00:00+08:00', NOW), Date.parse('2026-10-24T20:00:00+08:00'));
  assert.equal(parseResetHint('429 with no hint', NOW), null);
});

test('uses the host-reported provider delay rather than the retry cap as a reset hint', () => {
  const error = 'Retry failed after 1 attempts: Provider requested 12025998ms wait, exceeds retry.maxDelayMs (300000ms). Original error: Codex error event: The usage limit has been reached (code=usage_limit_reached)';
  assert.equal(parseResetHint(error, NOW), NOW + 12025998);
  assert.equal(isQuotaError(error), true);
});

const claudeBucket = (utilization, at = NOW + 3_600_000) => ({ utilization, resets_at: new Date(at).toISOString() });
const claudeShared = (fiveHour = 20, weekly = 30) => ({
  five_hour: claudeBucket(fiveHour),
  seven_day: claudeBucket(weekly, NOW + 10 * 3_600_000),
});
const scoped = (name, percent, at = NOW + 20 * 3_600_000) => ({
  kind: 'weekly_scoped', percent, resets_at: new Date(at).toISOString(),
  scope: { model: { display_name: name } },
});

test('Claude percentages are not fractions and exhaust exactly at 100 percent', () => {
  for (const used of [0, 0.9, 99, 99.999]) {
    const q = extractClaudeQuota(claudeShared(used), 'claude-sonnet-4-6', NOW);
    assert.equal(q.available, true);
    assert.equal(q.windows[0].usedPercent, used);
    assert.equal(q.windows[0].seconds, 18000);
    assert.equal(q.windows[1].seconds, 604800);
    assert.equal(q.nextResetAt, null);
  }
  for (const used of [100, 100.001, 125]) {
    const q = extractClaudeQuota(claudeShared(used), 'claude-sonnet-4-6', NOW);
    assert.equal(q.available, false);
    assert.equal(q.isRateBlocked, true);
    assert.equal(q.blocked.length, 1);
  }
});

test('Claude waits for all exhausted shared and relevant model windows', () => {
  const q = extractClaudeQuota({
    ...claudeShared(100, 100),
    seven_day_sonnet: claudeBucket(100, NOW + 20 * 3_600_000),
    seven_day_opus: claudeBucket(100, NOW + 30 * 3_600_000),
  }, 'claude-sonnet-4-6', NOW);
  assert.equal(q.available, false);
  assert.equal(q.blocked.length, 3);
  assert.equal(q.nextResetAt, NOW + 20 * 3_600_000);
  assert.deepEqual(q.windows.map(w => w.label), ['5h', 'week', 'week (Sonnet)']);
  assert.deepEqual(q.windows.map(w => w.type), ['5h', 'week', 'week']);
});

test('Claude does not let irrelevant legacy family caps block another model', () => {
  for (const [model, relevant, irrelevant] of [
    ['claude-sonnet-4-6', 'seven_day_sonnet', 'seven_day_opus'],
    ['anthropic/claude-3-opus-20240229', 'seven_day_opus', 'seven_day_sonnet'],
  ]) {
    const payload = { ...claudeShared(), [relevant]: claudeBucket(25), [irrelevant]: claudeBucket(100) };
    assert.equal(extractClaudeQuota(payload, model, NOW).available, true);
    payload[relevant] = claudeBucket(100);
    assert.equal(extractClaudeQuota(payload, model, NOW).available, false);
  }
  assert.equal(extractClaudeQuota({
    ...claudeShared(), seven_day_sonnet: claudeBucket(100), seven_day_opus: claudeBucket(100),
  }, 'claude-haiku-4-5', NOW).available, true);
});

test('Claude unknown and ambiguous model families honor every reported scope', () => {
  const payload = { ...claudeShared(), seven_day_opus: claudeBucket(100) };
  for (const model of ['', 'future-model', 'sonnetish', 'claude-opus-sonnet']) {
    const q = extractClaudeQuota(payload, model, NOW);
    assert.equal(q.available, false);
    assert.equal(q.blocked.length, 1);
  }
  assert.equal(extractClaudeQuota({
    ...claudeShared(), seven_day_opus: claudeBucket(15), seven_day_sonnet: claudeBucket(40),
  }, '', NOW).available, true);
});

test('Claude recognizes current generic shared and family-scoped OAuth windows', () => {
  const payload = {
    five_hour: null, seven_day: null, seven_day_opus: null, seven_day_sonnet: null,
    limits: [
      { kind: 'session', percent: 20, resets_at: new Date(NOW + 3_600_000).toISOString() },
      { kind: 'weekly_all', percent: 77, resets_at: new Date(NOW + 10 * 3_600_000).toISOString(), is_active: false },
      { ...scoped('Fable', 100), is_active: true },
      { ...scoped('Sonnet', 5), is_active: false },
    ],
  };
  const sonnet = extractClaudeQuota(payload, 'claude-sonnet-4-6', NOW);
  assert.equal(sonnet.available, true);
  assert.deepEqual(sonnet.windows.map(w => w.usedPercent), [20, 77, 5]);
  const fable = extractClaudeQuota(payload, 'claude-fable-5', NOW);
  assert.equal(fable.available, false);
  assert.equal(fable.blocked[0].label, 'week (Fable)');
  assert.equal(fable.nextResetAt, NOW + 20 * 3_600_000);
  payload.limits[1].percent = 100;
  assert.equal(extractClaudeQuota(payload, 'claude-sonnet-4-6', NOW).available, false);
});

test('Claude honors duplicate evidence and unknown or missing generic model scopes conservatively', () => {
  assert.equal(extractClaudeQuota({
    ...claudeShared(), limits: [{ kind: 'weekly_all', percent: 100 }],
  }, 'claude-sonnet-4-6', NOW).available, false);
  for (const scope of [{}, { model: {} }, { model: { display_name: 'New family' } }]) {
    const q = extractClaudeQuota({
      ...claudeShared(), limits: [{ ...scoped('Opus', 100), scope }],
    }, 'claude-sonnet-4-6', NOW);
    assert.equal(q.available, false);
    assert.equal(q.blocked.length, 1);
  }
});

test('Claude unknown or malformed utilization never implies availability', () => {
  for (const utilization of [null, undefined, '', '0', '99', false, NaN, Infinity, -1, {}, []]) {
    const actual = extractClaudeQuota({
      ...claudeShared(), five_hour: { utilization, resets_at: new Date(NOW + 3_600_000).toISOString() },
    }, 'claude-opus-4-6', NOW);
    assert.equal(actual.available, false);
    assert.equal(actual.windows[0].usedPercent, null);
    assert.equal(actual.isRateBlocked, false);
  }
  for (const bucket of [null, undefined, {}, [], 'invalid']) {
    const q = extractClaudeQuota({ ...claudeShared(), seven_day: bucket }, 'claude-opus-4-6', NOW);
    assert.equal(q.available, false);
  }
  assert.equal(extractClaudeQuota({ ...claudeShared(), seven_day_sonnet: {} }, 'claude-sonnet-4-6', NOW).available, false);
  assert.equal(extractClaudeQuota({ ...claudeShared(), seven_day_sonnet: {} }, 'claude-opus-4-6', NOW).available, true);
  assert.equal(extractClaudeQuota({
    ...claudeShared(), limits: [scoped('Sonnet', '0')],
  }, 'claude-sonnet-4-6', NOW).available, false);
});

test('Claude rejects incomplete, unrelated and malformed quota payloads safely', () => {
  for (const payload of [null, undefined, [], 'invalid', 123]) {
    assert.equal(extractClaudeQuota(payload, '', NOW), null);
  }
  for (const payload of [
    {}, { allowed: true }, { five_hour: claudeBucket(0) }, { seven_day: claudeBucket(0) },
    { ...claudeShared(), limits: {} }, { ...claudeShared(), limits: [null] },
    { ...claudeShared(), limits: [{ kind: 'new_gate', percent: 0 }] },
  ]) {
    assert.equal(extractClaudeQuota(payload, '', NOW).available, false);
  }
});

test('Claude ignores billing/overage and reset-credit inventory for subscription recovery', () => {
  const extras = {
    extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 0, utilization: 0 },
    spend: { enabled: true, used: { amount_minor: 0, currency: 'USD', exponent: 2 } },
    cedar_ember: { available_count: 3 }, juniper_tide: { available_count: 2 },
  };
  assert.equal(extractClaudeQuota(extras, 'claude-sonnet-4-6', NOW).available, false);
  assert.equal(extractClaudeQuota({ ...claudeShared(100), ...extras }, 'claude-sonnet-4-6', NOW).available, false);
  extras.extra_usage.used_credits = 100;
  assert.equal(extractClaudeQuota({ ...claudeShared(), ...extras }, 'claude-sonnet-4-6', NOW).available, true);
});

test('Claude reset timestamps schedule the latest exhausted gate without assuming time clears it', () => {
  const q = extractClaudeQuota({
    five_hour: claudeBucket(100, NOW - 1000),
    seven_day: claudeBucket(100, NOW + 3_600_000),
    seven_day_sonnet: claudeBucket(20, NOW + 50 * 3_600_000),
  }, 'claude-sonnet-4-6', NOW);
  assert.equal(q.available, false);
  assert.equal(q.nextResetAt, NOW + 3_600_000);
  assert.equal(extractClaudeQuota({
    ...claudeShared(), five_hour: claudeBucket(100, NOW - 1000),
  }, '', NOW).available, false);
  for (const reset of [null, 1792724400, 'tomorrow', '2026-10-23', '2026-10-23T03:00:00']) {
    const unknown = extractClaudeQuota({
      ...claudeShared(), five_hour: { utilization: 100, resets_at: reset },
    }, '', NOW);
    assert.equal(unknown.nextResetAt, null);
    assert.equal(unknown.available, false);
  }
  assert.equal(extractClaudeQuota({
    ...claudeShared(), five_hour: { utilization: 100, resets_at: '2026-10-23T11:00:00+08:00' },
  }, '', NOW).nextResetAt, Date.parse('2026-10-23T03:00:00Z'));
});


test('recognizes Claude subscription and native depleted-quota errors', () => {
  for (const error of [
    "You've hit your limit · resets 1:40pm (America/New_York)",
    "You've hit your session limit · resets 1:10am (Europe/Moscow)",
    "You've hit your weekly limit",
    "You've hit your Opus limit",
    "You've hit your Sonnet limit",
    'Claude usage limit reached',
    '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    'Usage preflight blocked: usage depleted for anthropic/claude-sonnet-4-6; reserve policy is fail-closed.',
  ]) assert.equal(isQuotaError(error), true, error);
  for (const error of [
    'Usage preflight blocked: reserve reached for anthropic/claude-sonnet-4-6; reserve policy is fail-closed.',
    'Connection error', 'Model not found', 'Your session expired',
  ]) assert.equal(isQuotaError(error), false, error);
});

test('billing and authentication exclusions take precedence over Claude rate-limit wording', () => {
  for (const reason of [
    'monthly spend limit', 'monthly spending cap', 'insufficient credits', 'credit balance is too low',
    'credits_required', 'Usage credits are required for this model', 'authentication_error',
    'permission_error', 'OAuth token has expired', 'forbidden', 'payment required',
  ]) assert.equal(isQuotaError(`429 rate_limit_error: ${reason}`), false, reason);
});

test('does not guess ambiguous Claude local reset clocks or timezone names', () => {
  assert.equal(parseResetHint("You've hit your limit · resets 1:40pm (America/New_York)", NOW), null);
  assert.equal(parseResetHint("You've hit your session limit · resets 1:10am (Europe/Moscow)", NOW), null);
});
