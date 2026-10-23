import test from 'node:test';
import assert from 'node:assert/strict';
import { extractQuota, isQuotaError, parseResetHint } from '../src/quota-core.mjs';

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

