/** Codex OAuth quota monitoring with native, message-free retry. */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractQuota, isQuotaError, parseResetHint, humanTime } from './quota-core.mjs';

const DEFAULTS = {
  enabled: true,
  pollMinutes: 10,
  resetSlackSeconds: 5,
  minResumeDelaySeconds: 20,
  maxResumesPerEpisode: 3,
  resumeAtHintIfUsageUnavailable: true,
};

function loadConfig(path) {
  const cfg = { ...DEFAULTS };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return cfg;
    // Only persist supported settings; old continuation prompts are no longer used.
    for (const key of Object.keys(DEFAULTS)) if (Object.hasOwn(value, key)) cfg[key] = value[key];
    cfg.pollMinutes = Number.isFinite(cfg.pollMinutes) ? Math.max(0.25, Math.min(60, cfg.pollMinutes)) : 10;
    cfg.resetSlackSeconds = Number.isFinite(cfg.resetSlackSeconds) ? Math.max(0, Math.min(120, cfg.resetSlackSeconds)) : 5;
    cfg.minResumeDelaySeconds = Number.isFinite(cfg.minResumeDelaySeconds) ? Math.max(5, Math.min(600, cfg.minResumeDelaySeconds)) : 20;
    cfg.maxResumesPerEpisode = Number.isInteger(cfg.maxResumesPerEpisode) ? Math.max(1, Math.min(20, cfg.maxResumesPerEpisode)) : 3;
    cfg.enabled = cfg.enabled === true;
    cfg.resumeAtHintIfUsageUnavailable = cfg.resumeAtHintIfUsageUnavailable === true;
  } catch { /* Missing or invalid configuration uses defaults. */ }
  return cfg;
}

function asError(message) {
  if (message?.role !== 'assistant' || (message.stopReason !== 'error' && !message.errorMessage)) return null;
  const error = String(message.errorMessage ?? '');
  return isQuotaError(error) ? error : null;
}

function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') return value;
  }
  return undefined;
}

function accountIdFromJwt(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    const account = payload['https://api.openai.com/auth']?.chatgpt_account_id ?? payload.chatgpt_account_id;
    return typeof account === 'string' && /^[a-zA-Z0-9_-]{5,128}$/.test(account) ? account : undefined;
  } catch { return undefined; }
}

function checkProvider(ctx) {
  const model = ctx.model;
  if (!model || !['openai-codex', 'openai'].includes(model.provider) || !ctx.modelRegistry?.isUsingOAuth?.(model)) {
    throw new Error('The current model must use Codex subscription OAuth.');
  }
  let base;
  try { base = new URL(model.baseUrl); } catch { throw new Error('Cannot verify the provider origin.'); }
  if (base.protocol !== 'https:' || base.hostname !== 'chatgpt.com' || base.port || base.username || base.password) {
    throw new Error('Quota monitoring requires the official https://chatgpt.com origin.');
  }
}

async function fetchCodexQuota(ctx) {
  checkProvider(ctx);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth?.ok || typeof auth.apiKey !== 'string' || !auth.apiKey) throw new Error('No active OAuth credential is available.');
  const accountId = headerValue(auth.headers, 'chatgpt-account-id') ?? accountIdFromJwt(auth.apiKey);
  const headers = { Authorization: `Bearer ${auth.apiKey}`, Accept: 'application/json' };
  if (accountId && /^[a-zA-Z0-9_-]{5,128}$/.test(accountId)) headers['ChatGPT-Account-Id'] = accountId;
  // Never forward credentials to a proxy, follow redirects, or log tokens.
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Quota endpoint HTTP ${response.status}`);
  const quota = extractQuota(await response.json(), String(ctx.model.id ?? ''));
  if (!quota) throw new Error('The provider returned no recognizable quota windows.');
  return quota;
}

function fmtQuota(quota) {
  if (!quota) return 'No quota data available.';
  return `${quota.windows.map((w) => `${w.type}: ${w.usedPercent === null ? 'unknown usage' : w.usedPercent.toFixed(1) + '% used'}; reset ${humanTime(w.resetAt)}`).join(' | ')} | ${quota.available ? 'available' : 'recovery not confirmed'}`;
}

export default function (pi) {
  const root = process.env.PI_CODING_AGENT_DIR || pi.pi?.getAgentDir?.() || join(homedir(), '.pi', 'agent');
  const configPath = join(root, 'quota-auto-continue.json');
  let cfg = loadConfig(configPath);
  let context = null;
  let pending = null;
  let lastError = null;
  let lastHttpResetAt = null;
  let timer = null;
  let generation = 0;
  let resumeCount = 0;
  let probingGeneration = null;
  let lastQuota = null;

  const sessionId = (ctx) => ctx?.sessionManager?.getSessionId?.();
  const modelKey = (ctx) => `${ctx?.model?.provider ?? ''}/${ctx?.model?.id ?? ''}`;
  const status = (ctx, text) => { try { if (ctx?.hasUI) ctx.ui.setStatus('quota-auto-continue', text || undefined); } catch {} };
  const notify = (ctx, text, level = 'info') => { try { if (ctx?.hasUI) ctx.ui.notify(text, level); else console.log(`[quota-auto-continue] ${text}`); } catch {} };

  function nativeSession(ctx) {
    const session = pi.pi?.AgentRegistry?.global?.().get(ctx.agent?.id)?.session;
    // Match the actual manager, not just a reusable agent ID or a session filename.
    if (session?.sessionManager !== ctx.sessionManager || typeof session.retry !== 'function') {
      throw new Error('This host does not expose native session retry. OMP 18.12.1 or a compatible host is required; no message fallback is used.');
    }
    return session;
  }

  function saveConfig() {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, configPath);
  }

  function clearTimer() { clearTimeout(timer); timer = null; }
  function cancel(ctx, why = '') {
    generation++;
    clearTimer();
    pending = null;
    lastError = null;
    lastHttpResetAt = null;
    resumeCount = 0;
    status(ctx, '');
    if (why) notify(ctx, `Automatic continuation cancelled: ${why}`);
  }
  function checkContext(ctx) {
    return !!pending && pending.sessionId === sessionId(ctx) && pending.modelKey === modelKey(ctx);
  }
  function schedule(ms) {
    clearTimer();
    if (!pending || !cfg.enabled) return;
    const gen = generation;
    pending.nextCheckAt = Date.now() + Math.max(500, ms);
    timer = setTimeout(() => {
      if (gen !== generation) return;
      void probe(gen).catch(() => {
        if (gen === generation) cancel(context, 'Unexpected monitoring failure; run /quota-resume check.');
      });
    }, Math.max(500, Math.min(ms, 2147483647)));
    timer?.unref?.();
  }
  function timing() {
    return `Next automatic continuation: ${pending.resumeAt ? `${humanTime(pending.resumeAt)} (estimated; requires quota recovery)` : 'unknown until recovery is confirmed'}. Next recovery check: ${humanTime(pending.nextCheckAt)}. Background polling: every ${cfg.pollMinutes} minutes.`;
  }
  function reportSchedule(ctx, force = false) {
    status(ctx, `Quota: ${pending.resumeAt ? humanTime(pending.resumeAt) : 'waiting for recovery'} | next check ${humanTime(pending.nextCheckAt)}`);
    if (force || pending.announcedResumeAt !== pending.resumeAt) {
      notify(ctx, `${pending.announcedResumeAt === undefined ? 'Quota limit detected.' : 'Continuation schedule updated.'} ${timing()}`, 'warning');
      pending.announcedResumeAt = pending.resumeAt;
    }
  }

  async function continueTask(ctx, recovered = true) {
    if (!pending || !checkContext(ctx) || !cfg.enabled) return;
    if (!ctx.isIdle()) { schedule(3000); reportSchedule(ctx); return; }
    if (ctx.hasPendingMessages?.()) { cancel(ctx, 'New messages are pending.'); return; }
    if (resumeCount >= cfg.maxResumesPerEpisode) { cancel(ctx, 'The continuation attempt limit was reached.'); return; }
    let session;
    try { session = nativeSession(ctx); } catch (err) { cancel(ctx, err.message); return; }
    resumeCount++;
    pending = null;
    clearTimer();
    const gen = ++generation;
    lastError = null;
    status(ctx, '');
    notify(ctx, `${recovered ? 'Quota recovery detected.' : 'Provider reset hint reached; the quota endpoint is unavailable.'} Next automatic continuation: ${humanTime(Date.now())} (now; attempt ${resumeCount}/${cfg.maxResumesPerEpisode}). Retrying the interrupted turn without adding a message. If quota blocks it again, a new continuation time will be reported.`);
    try {
      const accepted = await session.retry();
      if (!accepted && gen === generation) cancel(ctx, 'The host declined native retry; the interrupted turn may no longer be retryable.');
    } catch {
      if (gen === generation) cancel(ctx, 'Native retry failed; inspect the host error before retrying manually.');
    }
  }

  async function probe(gen, allowResume = true) {
    if (probingGeneration === gen || !pending || gen !== generation || !cfg.enabled) return;
    const ctx = context;
    if (!checkContext(ctx)) { cancel(ctx, 'The session or model changed.'); return; }
    probingGeneration = gen;
    try {
      let quota = null;
      let probeError = null;
      try { quota = await fetchCodexQuota(ctx); }
      catch (err) { probeError = String(err?.message || err); }
      if (gen !== generation || !pending || !checkContext(ctx)) return;
      pending.lastProbeError = probeError;
      if (quota) lastQuota = quota;
      const now = Date.now();
      const safeAt = pending.detectedAt + cfg.minResumeDelaySeconds * 1000;
      if (quota?.available) {
        pending.resumeAt = Math.max(now, safeAt);
        if (allowResume && now >= safeAt) { await continueTask(ctx); return; }
        schedule(Math.max(500, safeAt - now));
        reportSchedule(ctx);
        return;
      }
      // An authoritative blocked response always takes precedence over an old hint.
      if (quota) pending.resetAt = quota.nextResetAt;
      const resetAt = pending.resetAt ? pending.resetAt + cfg.resetSlackSeconds * 1000 : null;
      const hintAt = pending.hintResetAt ? Math.max(safeAt, pending.hintResetAt + cfg.resetSlackSeconds * 1000, resetAt ?? 0) : null;
      if (!quota && cfg.resumeAtHintIfUsageUnavailable && hintAt && now >= hintAt && allowResume) {
        await continueTask(ctx, false);
        return;
      }
      pending.resumeAt = resetAt && resetAt > now ? Math.max(safeAt, resetAt) : null;
      const next = Math.min(cfg.pollMinutes * 60000, pending.resumeAt ? pending.resumeAt - now : Infinity);
      schedule(Math.max(500, next));
      reportSchedule(ctx);
    } finally {
      if (probingGeneration === gen) probingGeneration = null;
    }
  }

  async function startWait(ctx, errorText) {
    if (!cfg.enabled) return;
    try { checkProvider(ctx); nativeSession(ctx); }
    catch (err) { notify(ctx, `Quota limit detected. Automatic continuation unavailable: ${err.message}`, 'warning'); return; }
    if (resumeCount >= cfg.maxResumesPerEpisode) {
      notify(ctx, 'Quota is still blocked. No next automatic continuation: the attempt limit was reached.', 'warning');
      return;
    }
    const hinted = [parseResetHint(errorText), lastHttpResetAt].filter((x) => x && x > Date.now() - 60000);
    const time = hinted.length ? Math.max(...hinted) : null;
    const gen = ++generation;
    clearTimer();
    context = ctx;
    pending = {
      sessionId: sessionId(ctx), modelKey: modelKey(ctx), detectedAt: Date.now(),
      resetAt: time, hintResetAt: time, resumeAt: time ? Math.max(time + cfg.resetSlackSeconds * 1000, Date.now() + cfg.minResumeDelaySeconds * 1000) : null,
      nextCheckAt: Date.now(), lastProbeError: null, announcedResumeAt: undefined,
    };
    reportSchedule(ctx);
    // Never re-enter native retry from within a settlement hook.
    await probe(gen, false);
  }

  function noticeError(message, ctx) {
    const error = asError(message);
    if (error) lastError = { text: error, sessionId: sessionId(ctx), modelKey: modelKey(ctx) };
    else if (message?.role === 'assistant') lastError = null;
  }

  pi.on('session_start', (_event, ctx) => { cfg = loadConfig(configPath); context = ctx; cancel(ctx); });
  pi.on('session_shutdown', (_event, ctx) => { cancel(ctx); context = null; });
  pi.on('session_switch', (_event, ctx) => { cancel(ctx); context = ctx; });
  pi.on('model_select', (_event, ctx) => { if (pending) cancel(ctx, 'The model changed.'); });
  pi.on('input', (event, ctx) => {
    // User input always takes priority, including input racing an in-flight quota request.
    if (event.source !== 'extension') cancel(ctx, pending ? 'New user input received.' : '');
  });
  pi.on('after_provider_response', (event) => {
    if (event.status !== 429) return;
    const value = headerValue(event.headers, 'retry-after');
    if (!value) return;
    const seconds = Number(value);
    lastHttpResetAt = Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : Date.parse(value);
    if (!Number.isFinite(lastHttpResetAt)) lastHttpResetAt = null;
  });
  pi.on('message_end', (event, ctx) => noticeError(event.message, ctx));
  pi.on('turn_end', (event, ctx) => noticeError(event.message, ctx));
  pi.on('agent_end', async (event, ctx) => {
    const message = event.messages?.findLast((m) => m?.role === 'assistant');
    if (message?.stopReason === 'aborted') { cancel(ctx); return; }
    if (message) noticeError(message, ctx);
    // OMP emits nonterminal agent_end notifications before host-managed recovery.
    if (event.willContinue || event.willRetry || pending || !cfg.enabled) return;
    if (!lastError) { resumeCount = 0; lastHttpResetAt = null; return; }
    const error = lastError;
    lastError = null;
    if (error.sessionId !== sessionId(ctx) || error.modelKey !== modelKey(ctx)) return;
    await startWait(ctx, error.text);
  });

  pi.registerCommand('quota-resume', {
    description: 'Codex quota monitor: status | check | on | off | cancel | interval <minutes>',
    handler: async (args, ctx) => {
      const [cmd = 'status', val] = String(args || '').trim().split(/\s+/);
      context = ctx;
      if (cmd === 'on' || cmd === 'off') {
        cfg.enabled = cmd === 'on';
        saveConfig();
        if (!cfg.enabled) cancel(ctx, 'Automatic continuation disabled.');
        notify(ctx, `Automatic continuation: ${cfg.enabled ? 'on' : 'off'}.`);
      } else if (cmd === 'cancel') {
        cancel(ctx, 'Cancelled by the user.');
      } else if (cmd === 'interval') {
        const minutes = Number(val);
        if (!Number.isFinite(minutes) || minutes < 0.25 || minutes > 60) {
          notify(ctx, 'The interval must be between 0.25 and 60 minutes, for example /quota-resume interval 10.', 'warning'); return;
        }
        cfg.pollMinutes = minutes;
        saveConfig();
        notify(ctx, `Background polling interval: ${minutes} minutes.`);
        if (pending) { schedule(500); reportSchedule(ctx, true); }
      } else if (cmd === 'check') {
        if (pending) { await probe(generation); if (pending) notify(ctx, `${fmtQuota(lastQuota)} ${timing()}${pending.lastProbeError ? ` Last check: ${pending.lastProbeError}` : ''}`); }
        else {
          try { lastQuota = await fetchCodexQuota(ctx); notify(ctx, fmtQuota(lastQuota)); }
          catch (err) { notify(ctx, `Quota check failed: ${String(err?.message || err)}`, 'warning'); }
        }
      } else if (cmd === 'status') {
        notify(ctx, `Automatic continuation: ${cfg.enabled ? 'on' : 'off'}. ${pending ? timing() : 'No pending continuation.'} Attempts: ${resumeCount}/${cfg.maxResumesPerEpisode}. ${fmtQuota(lastQuota)}${pending?.lastProbeError ? ` Last check: ${pending.lastProbeError}` : ''}`);
      } else {
        notify(ctx, 'Usage: /quota-resume status | check | on | off | cancel | interval 10', 'warning');
      }
    },
  });
}
