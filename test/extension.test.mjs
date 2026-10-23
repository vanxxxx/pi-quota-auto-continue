import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import create from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 23, 2);
const quotaPayload = (used, resetAt = NOW + 3_600_000, weeklyUsed = 5) => ({
  rate_limit: {
    primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: resetAt / 1000 },
    secondary_window: { used_percent: weeklyUsed, limit_window_seconds: 604800, reset_at: (NOW + 7_200_000) / 1000 },
  },
});

function harness(t, config = {}, model = { provider: 'openai-codex', id: 'gpt-5.4', baseUrl: 'https://chatgpt.com/backend-api/codex' }) {
  const root = mkdtempSync(join(tmpdir(), 'quota-test-'));
  const previousRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, 'quota-auto-continue.json'), JSON.stringify(config));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const retries = [];
  const entries = [];
  let payload = quotaPayload(100);
  let requests = 0;
  let sessionId = 'session-A';
  let fetchResponse = async () => ({ ok: true, json: async () => payload });
  t.mock.method(globalThis, 'fetch', async (...args) => { requests++; return fetchResponse(...args); });
  const ctx = {
    agent: { kind: 'main', id: 'main' },
    model,
    modelRegistry: { isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: model.provider === 'anthropic' ? 'sk-ant-oat01-test-only-token' : 'test-only-token' }) },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }), setStatus() {} },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  const session = { sessionManager: ctx.sessionManager, retry: async () => { retries.push(Date.now()); return true; } };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage() { assert.fail('Continuation must not append a user message'); },
    sendMessage() { assert.fail('Continuation must not append a hidden custom message'); },
    pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } },
  };
  create(pi);
  handlers.get('session_start')({}, ctx);
  const emit = (name, event = {}) => {
    if (name === 'message_end') entries.push({ type: 'message', message: event.message });
    return handlers.get(name)(event, ctx);
  };
  t.after(() => {
    emit('session_shutdown');
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    ctx, session, notices, retries, entries,
    get requests() { return requests; },
    get payload() { return payload; },
    set payload(value) { payload = value; },
    set fetchResponse(value) { fetchResponse = value; },
    set sessionId(value) { sessionId = value; },
    emit,
    async restart() {
      await emit('session_shutdown');
      create(pi);
      await emit('session_start');
    },
    command: (args) => commands.get('quota-resume').handler(args, ctx),
    async fail(errorMessage = '429: usage_limit_reached') {
      const message = { role: 'assistant', stopReason: 'error', errorMessage };
      emit('message_end', { message });
      await emit('agent_end', { messages: [message] });
    },
    async advance(ms) {
      t.mock.timers.tick(ms);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

test('silently polls every thirty minutes and retries early recovery without a message', async (t) => {
  const h = harness(t);
  await h.fail();
  assert.equal(h.requests, 1);
  assert.equal(h.retries.length, 0);
  assert.ok(h.notices.some(({ text }) => text.includes(new Date(NOW + 3_605_000).toLocaleString())));
  const count = h.notices.length;
  await h.advance(1_799_999);
  assert.equal(h.requests, 1);
  await h.advance(1);
  assert.equal(h.requests, 2);
  assert.equal(h.notices.length, count, 'Unchanged background checks must stay silent');
  h.payload = quotaPayload(20);
  await h.advance(1_800_000);
  assert.deepEqual(h.retries, [NOW + 3_600_000]);
  assert.ok(h.notices.at(-1).text.includes(new Date(NOW + 3_600_000).toLocaleString()));
  await h.advance(1_800_000);
  assert.equal(h.retries.length, 1, 'A recovered episode must not dispatch duplicate retries');
});

test('checks the later exhausted window at reset plus slack, not an earlier error hint', async (t) => {
  const h = harness(t);
  h.payload = quotaPayload(100, NOW + 30_000, 100);
  await h.fail('429 usage_limit_reached retry after 1 seconds');
  await h.advance(20_000);
  assert.equal(h.retries.length, 0);
  h.payload = quotaPayload(10, NOW + 30_000, 100);
  await h.command('check');
  assert.equal(h.retries.length, 0);
  assert.ok(h.notices.some(({ text }) => text.includes(new Date(NOW + 7_205_000).toLocaleString())));
});

test('honors minimum delay when quota is already available', async (t) => {
  const h = harness(t);
  h.payload = quotaPayload(10);
  await h.fail();
  await h.advance(19_999);
  assert.equal(h.retries.length, 0);
  await h.advance(1);
  assert.deepEqual(h.retries, [NOW + 20_000]);
});

test('a new input racing a quota request prevents stale continuation', async (t) => {
  const h = harness(t);
  let release;
  h.fetchResponse = () => new Promise((resolve) => { release = resolve; });
  const waiting = h.fail();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await h.emit('input', { source: 'interactive' });
  release({ ok: true, json: async () => quotaPayload(10) });
  await waiting;
  await h.advance(600_000);
  assert.equal(h.retries.length, 0);
  assert.equal(h.requests, 1);
});

test('session replacement and explicit abort cancel recovery while queued work defers it', async (t) => {
  const h = harness(t);
  await h.fail();
  h.sessionId = 'session-B';
  h.payload = quotaPayload(10);
  await h.advance(1_800_000);
  assert.equal(h.retries.length, 0);
  await h.fail();
  h.ctx.hasPendingMessages = () => true;
  await h.advance(20_000);
  assert.equal(h.retries.length, 0);
  h.ctx.hasPendingMessages = () => false;
  await h.fail();
  await h.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] });
  await h.advance(600_000);
  assert.equal(h.retries.length, 0);
});

test('hint fallback requires endpoint failure and respects the episode attempt cap', async (t) => {
  const h = harness(t, { maxResumesPerEpisode: 2 });
  h.fetchResponse = async () => { throw new Error('offline'); };
  await h.fail('429 usage_limit_reached retry after 30 seconds');
  await h.advance(35_000);
  assert.deepEqual(h.retries, [NOW + 35_000]);
  await h.fail('429 usage_limit_reached retry after 30 seconds');
  await h.advance(35_000);
  assert.equal(h.retries.length, 2);
  await h.fail('429 usage_limit_reached retry after 30 seconds');
  await h.advance(600_000);
  assert.equal(h.retries.length, 2);
});

test('unsupported hosts and untrusted origins never receive credentials or message fallbacks', async (t) => {
  const h = harness(t);
  h.ctx.model.baseUrl = 'https://chatgpt.com@evil.invalid/backend-api/codex';
  await h.fail();
  assert.equal(h.requests, 0);
  h.ctx.model.baseUrl = 'https://chatgpt.com/backend-api/codex';
  h.session.retry = undefined;
  await h.fail();
  assert.equal(h.requests, 0);
  assert.equal(h.retries.length, 0);
});

test('normal assistant prose mentioning a quota does not schedule continuation', async (t) => {
  const h = harness(t);
  await h.emit('message_end', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '429 usage_limit_reached' }] } });
  await h.emit('agent_end', { messages: [] });
  await h.advance(600_000);
  assert.equal(h.requests, 0);
  assert.equal(h.retries.length, 0);
});

test('Claude Code waits for shared and Sonnet windows, then retries without conversation messages', async (t) => {
  const h = harness(t, {}, { provider: 'anthropic', id: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com' });
  h.payload = {
    five_hour: { utilization: 100, resets_at: new Date(NOW + 30_000).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(NOW + 7_200_000).toISOString() },
    seven_day_sonnet: null,
    seven_day_opus: null,
    limits: [
      { kind: 'weekly_scoped', percent: 100, resets_at: new Date(NOW + 3_600_000).toISOString(), scope: { model: { display_name: 'Sonnet' } }, is_active: false },
      { kind: 'weekly_scoped', percent: 100, resets_at: new Date(NOW + 14_400_000).toISOString(), scope: { model: { display_name: 'Opus' } }, is_active: true },
    ],
  };
  await h.fail("You've hit your limit");
  assert.equal(h.requests, 1);
  assert.ok(h.notices.some(({ text }) => text.includes(new Date(NOW + 3_605_000).toLocaleString())));
  const count = h.notices.length;
  h.payload.five_hour.utilization = 10;
  await h.advance(1_800_000);
  assert.equal(h.requests, 2);
  assert.equal(h.retries.length, 0, 'The exhausted Sonnet window must still block recovery');
  assert.equal(h.notices.length, count, 'Unchanged Claude polling must stay silent');
  h.payload.limits[0].percent = 10;
  await h.advance(1_800_000);
  assert.deepEqual(h.retries, [NOW + 3_600_000]);
});

test('Claude reset checks honor slack before retrying the interrupted turn', async (t) => {
  const h = harness(t, {}, { provider: 'anthropic', id: 'claude-opus-4-6', baseUrl: 'https://api.anthropic.com/v1' });
  h.payload = {
    five_hour: { utilization: 100, resets_at: new Date(NOW + 30_000).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(NOW + 7_200_000).toISOString() },
  };
  await h.fail('429 rate_limit_error');
  h.payload.five_hour.utilization = 10;
  await h.advance(34_999);
  assert.equal(h.retries.length, 0);
  await h.advance(1);
  assert.deepEqual(h.retries, [NOW + 35_000]);
});

test('Claude monitoring never obtains credentials for proxy origins or API-key accounts', async (t) => {
  const h = harness(t, {}, { provider: 'anthropic', id: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com.evil.invalid' });
  let credentialReads = 0;
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => { credentialReads++; throw new Error('Credentials must stay private'); };
  await h.fail('429 rate_limit_error');
  assert.equal(credentialReads, 0);
  h.ctx.model.baseUrl = 'https://api.anthropic.com';
  h.ctx.modelRegistry.isUsingOAuth = () => false;
  await h.fail('429 rate_limit_error');
  assert.equal(credentialReads, 0);
  assert.equal(h.requests, 0);
  assert.equal(h.retries.length, 0);
});

test('missing Claude quota data cannot trigger recovery or spend extra usage', async (t) => {
  const h = harness(t, {}, { provider: 'anthropic', id: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com' });
  h.payload = { five_hour: null, seven_day: null, extra_usage: { is_enabled: true, utilization: 1, monthly_limit: 100 } };
  await h.fail('429 rate_limit_error');
  await h.advance(1_800_000);
  assert.equal(h.requests, 2);
  assert.equal(h.retries.length, 0);
});

test('a selected Anthropic API key cannot use a saved OAuth account or reset hint to auto-resume', async (t) => {
  const h = harness(t, {}, { provider: 'anthropic', id: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com' });
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'sk-ant-api03-test-only-key' });
  await h.fail('429 rate_limit_error retry after 30 seconds');
  await h.advance(600_000);
  assert.equal(h.requests, 0);
  assert.equal(h.retries.length, 0);
});

test('consolidates the first quota response into one scheduled notice', async (t) => {
  const h = harness(t);
  await h.fail('Retry failed after 1 attempts: Provider requested 12025998ms wait, exceeds retry.maxDelayMs (300000ms). Original error: Codex error event: The usage limit has been reached (code=usage_limit_reached)');
  assert.equal(h.notices.length, 1, 'One quota interruption must produce one notice, not an unknown notice followed by a schedule update');
  assert.ok(h.notices[0].text.includes(new Date(NOW + 3_605_000).toLocaleString()));
  assert.equal(h.requests, 1);
});


test('interval zero disables recurring checks but preserves one known reset deadline', async (t) => {
  const h = harness(t);
  await h.command('interval 0');
  await h.fail();
  await h.advance(1_800_000);
  assert.equal(h.requests, 1, 'Disabled recurring polling must not query the provider every thirty minutes');
  h.payload = quotaPayload(10);
  await h.advance(1_804_999);
  assert.equal(h.retries.length, 0);
  await h.advance(1);
  assert.deepEqual(h.retries, [NOW + 3_605_000]);
});

test('interval zero without any reset hint stays dormant until a manual check', async (t) => {
  const h = harness(t, { pollMinutes: 0 });
  h.fetchResponse = async () => { throw new Error('offline'); };
  await h.fail();
  await h.advance(86_400_000);
  assert.equal(h.requests, 1);
  assert.equal(h.retries.length, 0);
  await h.command('check');
  assert.equal(h.requests, 2);
});

test('a reopened failed session restores its wait and resumes without repeating the quota notice', async (t) => {
  const h = harness(t);
  await h.fail();
  await h.advance(30_000);
  h.payload = quotaPayload(10);
  await h.restart();
  assert.equal(h.notices.filter(({ level }) => level === 'warning').length, 1);
  await h.advance(500);
  assert.deepEqual(h.retries, [NOW + 30_500]);
  assert.equal(h.requests, 2);
});

test('explicit cancellation survives reopening an unchanged failed transcript', async (t) => {
  const h = harness(t);
  await h.fail();
  await h.command('cancel');
  h.payload = quotaPayload(10);
  await h.restart();
  await h.advance(3_605_000);
  assert.equal(h.requests, 1);
  assert.equal(h.retries.length, 0);
});

test('restores an older quota failure with no saved recovery metadata', async (t) => {
  const h = harness(t);
  await h.fail();
  for (let i = h.entries.length - 1; i >= 0; i--) if (h.entries[i].type === 'custom') h.entries.splice(i, 1);
  await h.advance(30_000);
  h.payload = quotaPayload(10);
  await h.restart();
  await h.advance(19_999);
  assert.equal(h.retries.length, 0);
  await h.advance(1);
  assert.equal(h.retries.length, 1);
});

test('temporary native retry refusal keeps the episode without spending an attempt or re-querying quota', async (t) => {
  const h = harness(t, { maxResumesPerEpisode: 1 });
  h.payload = quotaPayload(10);
  let refused = false;
  h.session.retry = async () => {
    if (!refused) { refused = true; return false; }
    h.retries.push(Date.now());
    return true;
  };
  await h.fail();
  await h.advance(20_000);
  assert.equal(h.retries.length, 0);
  await h.advance(3000);
  assert.deepEqual(h.retries, [NOW + 23_000]);
  assert.equal(h.requests, 1);
  assert.equal(h.notices.filter(({ level }) => level === 'warning').length, 1);
});

test('waits out host compaction without extra provider requests', async (t) => {
  const h = harness(t);
  h.payload = quotaPayload(10);
  h.session.isCompacting = true;
  await h.fail();
  await h.advance(20_000);
  assert.equal(h.retries.length, 0);
  h.session.isCompacting = false;
  await h.advance(3000);
  assert.equal(h.retries.length, 1);
  assert.equal(h.requests, 1);
});

test('native max-delay timing arms a one-shot reset when periodic queries are disabled', async (t) => {
  const h = harness(t, { pollMinutes: 0 });
  h.fetchResponse = async () => { throw new Error('offline'); };
  await h.emit('auto_retry_end', {
    success: false,
    finalError: 'Provider requested 12025998ms wait, exceeds retry.maxDelayMs (300000ms). Original error: usage_limit_reached',
  });
  await h.fail('Codex error event: The usage limit has been reached (code=usage_limit_reached)');
  await h.advance(12030997);
  assert.equal(h.retries.length, 0);
  await h.advance(1);
  assert.deepEqual(h.retries, [NOW + 12030998]);
  assert.equal(h.requests, 2);
});

test('a live model change invalidates a captured old model context before any new quota request', async (t) => {
  const h = harness(t);
  await h.fail();
  h.session.model = { ...h.ctx.model, id: 'replacement-model' };
  await h.advance(1_800_000);
  assert.equal(h.requests, 1);
  assert.equal(h.retries.length, 0);
});

test('later quota estimates and repeated quota failures do not repeat the episode warning', async (t) => {
  const h = harness(t);
  await h.fail();
  h.payload = quotaPayload(100, NOW + 7_200_000);
  await h.advance(1_800_000);
  assert.equal(h.notices.length, 1);
  h.payload = quotaPayload(10);
  await h.advance(1_800_000);
  assert.equal(h.retries.length, 1);
  h.payload = quotaPayload(100, NOW + 10_800_000);
  await h.fail();
  assert.equal(h.notices.filter(({ level }) => level === 'warning').length, 1);
});
