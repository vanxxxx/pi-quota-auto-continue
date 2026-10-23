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

function harness(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quota-test-'));
  const previousRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  writeFileSync(join(root, 'quota-auto-continue.json'), JSON.stringify(config));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const handlers = new Map();
  const commands = new Map();
  const notices = [];
  const retries = [];
  let payload = quotaPayload(100);
  let requests = 0;
  let sessionId = 'session-A';
  let fetchResponse = async () => ({ ok: true, json: async () => payload });
  t.mock.method(globalThis, 'fetch', async (...args) => { requests++; return fetchResponse(...args); });
  const ctx = {
    agent: { kind: 'main', id: 'main' },
    model: { provider: 'openai-codex', id: 'gpt-5.4', baseUrl: 'https://chatgpt.com/backend-api/codex' },
    modelRegistry: { isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-only-token' }) },
    sessionManager: { getSessionId: () => sessionId },
    hasUI: true,
    ui: { notify: (text, level) => notices.push({ text, level }), setStatus() {} },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  const session = { sessionManager: ctx.sessionManager, retry: async () => { retries.push(Date.now()); return true; } };
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage() { assert.fail('Continuation must not append a user message'); },
    sendMessage() { assert.fail('Continuation must not append a hidden custom message'); },
    pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } },
  };
  create(pi);
  handlers.get('session_start')({}, ctx);
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  t.after(() => {
    emit('session_shutdown');
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousRoot;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    ctx, session, notices, retries,
    get requests() { return requests; },
    set payload(value) { payload = value; },
    set fetchResponse(value) { fetchResponse = value; },
    set sessionId(value) { sessionId = value; },
    emit,
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

test('silently polls every ten minutes and retries early recovery without a message', async (t) => {
  const h = harness(t);
  await h.fail();
  assert.equal(h.requests, 1);
  assert.equal(h.retries.length, 0);
  assert.ok(h.notices.some(({ text }) => text.includes(new Date(NOW + 3_605_000).toLocaleString())));
  const count = h.notices.length;
  await h.advance(599_999);
  assert.equal(h.requests, 1);
  await h.advance(1);
  assert.equal(h.requests, 2);
  assert.equal(h.notices.length, count, 'Unchanged background checks must stay silent');
  h.payload = quotaPayload(20);
  await h.advance(600_000);
  assert.deepEqual(h.retries, [NOW + 1_200_000]);
  assert.ok(h.notices.at(-1).text.includes(new Date(NOW + 1_200_000).toLocaleString()));
  await h.advance(600_000);
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

test('session replacement, queued messages, and explicit abort cancel pending recovery', async (t) => {
  const h = harness(t);
  await h.fail();
  h.sessionId = 'session-B';
  h.payload = quotaPayload(10);
  await h.advance(600_000);
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
