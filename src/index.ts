/** Subscription quota monitoring with native, message-free retry. */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isQuotaError, parseResetHint, humanTime } from './quota-core.mjs';
import { checkProvider, fetchQuota, headerValue, UnsupportedQuotaProviderError } from './quota-provider.mjs';

const STATE_TYPE = 'quota-auto-continue';
const DEFAULTS = {
  enabled: true,
  pollMinutes: 30,
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
    for (const key of Object.keys(DEFAULTS)) if (Object.hasOwn(value, key)) cfg[key] = value[key];
    cfg.pollMinutes = cfg.pollMinutes === 0 ? 0 : Number.isFinite(cfg.pollMinutes) ? Math.max(0.25, Math.min(60, cfg.pollMinutes)) : 30;
    cfg.resetSlackSeconds = Number.isFinite(cfg.resetSlackSeconds) ? Math.max(0, Math.min(120, cfg.resetSlackSeconds)) : 5;
    cfg.minResumeDelaySeconds = Number.isFinite(cfg.minResumeDelaySeconds) ? Math.max(5, Math.min(600, cfg.minResumeDelaySeconds)) : 20;
    cfg.maxResumesPerEpisode = Number.isInteger(cfg.maxResumesPerEpisode) ? Math.max(1, Math.min(20, cfg.maxResumesPerEpisode)) : 3;
    cfg.enabled = cfg.enabled === true;
    cfg.resumeAtHintIfUsageUnavailable = cfg.resumeAtHintIfUsageUnavailable === true;
  } catch { /* Missing or invalid configuration uses defaults. */ }
  return cfg;
}

function asError(message) {
  if (message?.role !== 'assistant' || message.stopReason !== 'error') return null;
  const error = String(message.errorMessage ?? '');
  return isQuotaError(error) ? error : null;
}

function fmtQuota(quota) {
  if (!quota) return 'No quota data available.';
  return `${quota.provider} | ${quota.windows.map((w) => `${w.label ?? w.type}: ${w.usedPercent === null ? 'unknown usage' : w.usedPercent.toFixed(1) + '% used'}; reset ${humanTime(w.resetAt)}`).join(' | ')} | ${quota.available ? 'available' : 'recovery not confirmed'}`;
}

export default function (pi) {
  const root = process.env.PI_CODING_AGENT_DIR || pi.pi?.getAgentDir?.() || join(homedir(), '.pi', 'agent');
  const configPath = join(root, 'quota-auto-continue.json');
  let cfg = loadConfig(configPath);
  let context = null;
  let activeSessionId = null;
  let pending = null;
  let lastError = null;
  let lastResetHint = null;
  let timer = null;
  let generation = 0;
  let resumeCount = 0;
  let episodeAnnounced = false;
  let limitReported = false;
  let probingGeneration = null;
  let lastQuota = null;
  let savedState = null;

  const sessionId = (ctx) => ctx?.sessionManager?.getSessionId?.();
  const modelKey = (model) => `${model?.provider ?? ''}/${model?.id ?? ''}@${model?.baseUrl ?? ''}`;
  const status = (ctx, text) => { try { if (ctx?.hasUI) ctx.ui.setStatus(STATE_TYPE, text || undefined); } catch {} };
  const notify = (ctx, text, level = 'info') => { try { if (ctx?.hasUI) ctx.ui.notify(text, level); else console.log(`[${STATE_TYPE}] ${text}`); } catch {} };

  function nativeSession(ctx) {
    const session = pi.pi?.AgentRegistry?.global?.().get(ctx.agent?.id)?.session;
    if (!session || !sessionId(ctx) || session.sessionManager?.getSessionId?.() !== sessionId(ctx) || typeof session.retry !== 'function') {
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

  function persistState(state) {
    const serialized = JSON.stringify(state);
    if (serialized === savedState) return;
    // Custom entries are session metadata, never user/custom messages or model context.
    pi.appendEntry?.(STATE_TYPE, state);
    savedState = serialized;
  }
  function persistWait(state = 'waiting') {
    if (!pending) return;
    persistState({ version: 1, state, sessionId: pending.sessionId, modelKey: pending.modelKey,
      detectedAt: pending.detectedAt, resetAt: pending.resetAt, hintResetAt: pending.hintResetAt,
      attempts: resumeCount, announced: episodeAnnounced });
  }
  function clearTimer() { clearTimeout(timer); timer = null; }
  function cancel(ctx, why = '', persist = true) {
    if (persist && (pending || episodeAnnounced || resumeCount)) persistState({ version: 1, state: 'cancelled' });
    generation++;
    clearTimer();
    pending = null;
    lastError = null;
    lastResetHint = null;
    resumeCount = 0;
    episodeAnnounced = false;
    limitReported = false;
    status(ctx, '');
    if (why) notify(ctx, `Automatic continuation cancelled: ${why}`);
  }
  function checkContext(ctx) {
    if (!pending || pending.sessionId !== sessionId(ctx)) return false;
    try { return pending.modelKey === modelKey(nativeSession(ctx).model ?? ctx.model); }
    catch { return false; }
  }
  function schedule(ms) {
    clearTimer();
    if (!pending || !cfg.enabled) return;
    pending.nextCheckAt = null;
    if (!Number.isFinite(ms)) return;
    const gen = generation;
    const delay = Math.max(500, Math.min(ms, 2147483647));
    pending.nextCheckAt = Date.now() + delay;
    timer = setTimeout(() => {
      if (gen !== generation) return;
      void probe(gen).catch(() => {
        if (gen === generation) cancel(context, 'Unexpected monitoring failure; run /quota-resume check.');
      });
    }, delay);
    timer?.unref?.();
  }
  function scheduleNext() {
    const now = Date.now();
    const periodic = cfg.pollMinutes > 0 ? cfg.pollMinutes * 60000 : Infinity;
    const deadline = pending.resumeAt && pending.resumeAt > now ? pending.resumeAt - now : Infinity;
    schedule(pending.ready ? Math.max(500, (pending.resumeAt ?? now) - now) : Math.min(periodic, deadline));
  }
  function timing() {
    return `Next automatic continuation: ${pending.resumeAt ? `${humanTime(pending.resumeAt)} (estimated; requires quota recovery)` : 'unknown until recovery is confirmed'}. Next recovery check: ${pending.nextCheckAt ? humanTime(pending.nextCheckAt) : 'manual check only until a reset time is known'}. Background polling: ${cfg.pollMinutes ? `every ${cfg.pollMinutes} minutes` : 'off'}.`;
  }
  function reportSchedule(ctx) {
    status(ctx, `Quota: ${pending.resumeAt ? humanTime(pending.resumeAt) : 'waiting for recovery'} | ${pending.nextCheckAt ? `next check ${humanTime(pending.nextCheckAt)}` : 'periodic checks off'}`);
    if (!episodeAnnounced) {
      notify(ctx, `${pending.provider} quota limit detected; automatic recovery is armed. ${timing()}`, 'warning');
      episodeAnnounced = true;
    }
    persistWait();
  }

  function lastConversationMessage(ctx) {
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const message = entries[i].type === 'message' ? entries[i].message : null;
      if (message?.role === 'user' || message?.role === 'assistant') return message;
    }
    return null;
  }

  async function continueTask(ctx) {
    if (!pending || !checkContext(ctx) || !cfg.enabled || pending.dispatching) return;
    const session = nativeSession(ctx);
    if (!ctx.isIdle() || session.isCompacting || session.isRetrying || ctx.hasPendingMessages?.()) {
      schedule(3000);
      status(ctx, 'Quota recovered; waiting for the host to become idle.');
      return;
    }
    if (resumeCount >= cfg.maxResumesPerEpisode) { cancel(ctx, 'The continuation attempt limit was reached.'); return; }
    const gen = generation;
    const waiting = pending;
    waiting.dispatching = true;
    clearTimer();
    try {
      const accepted = await session.retry();
      if (gen !== generation || pending !== waiting) return;
      waiting.dispatching = false;
      if (!accepted) {
        const tail = lastConversationMessage(ctx);
        if (tail && !asError(tail)) { cancel(ctx, 'The failed quota turn was superseded.'); return; }
        // Prompt unwind/compaction can refuse admission even when isIdle() was true.
        schedule(3000);
        status(ctx, 'Quota recovered; native retry admission is deferred.');
        return;
      }
      resumeCount++;
      persistWait('retrying');
      pending = null;
      generation++;
      lastError = null;
      status(ctx, '');
      notify(ctx, `${waiting.recovered ? 'Quota recovery confirmed.' : 'Provider reset hint reached; the usage endpoint is unavailable.'} Automatic continuation: ${humanTime(Date.now())} (now; attempt ${resumeCount}/${cfg.maxResumesPerEpisode}). Native retry accepted without adding a message.`);
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
      const safeAt = pending.detectedAt + cfg.minResumeDelaySeconds * 1000;
      if (pending.ready && allowResume && Date.now() >= safeAt) { await continueTask(ctx); return; }
      let quota = null;
      let probeError = null;
      const model = nativeSession(ctx).model ?? ctx.model;
      try { quota = await fetchQuota({ model, modelRegistry: ctx.modelRegistry }); }
      catch (err) {
        if (gen !== generation || !pending || !checkContext(ctx)) return;
        if (err instanceof UnsupportedQuotaProviderError) { cancel(ctx, err.message); return; }
        probeError = String(err?.message || err);
      }
      if (gen !== generation || !pending || !checkContext(ctx)) return;
      pending.lastProbeError = probeError;
      if (quota) lastQuota = quota;
      const now = Date.now();
      if (quota?.available) {
        pending.ready = true;
        pending.recovered = true;
        pending.resumeAt = Math.max(now, safeAt);
        if (allowResume && now >= safeAt) { await continueTask(ctx); return; }
        scheduleNext();
        reportSchedule(ctx);
        return;
      }
      if (quota) pending.resetAt = quota.nextResetAt;
      const resetAt = pending.resetAt ? pending.resetAt + cfg.resetSlackSeconds * 1000 : null;
      const hintAt = pending.hintResetAt ? Math.max(safeAt, pending.hintResetAt + cfg.resetSlackSeconds * 1000, resetAt ?? 0) : null;
      if (!quota && cfg.resumeAtHintIfUsageUnavailable && hintAt && now >= hintAt) {
        pending.ready = true;
        pending.recovered = false;
        pending.resumeAt = Math.max(now, safeAt);
        if (allowResume) { await continueTask(ctx); return; }
      } else pending.resumeAt = resetAt && resetAt > now ? Math.max(safeAt, resetAt) : null;
      scheduleNext();
      reportSchedule(ctx);
    } finally {
      if (probingGeneration === gen) probingGeneration = null;
    }
  }

  async function startWait(ctx, errorText, restored = null) {
    if (!cfg.enabled) return;
    let provider;
    try { provider = checkProvider(ctx); nativeSession(ctx); }
    catch (err) { notify(ctx, `Quota limit detected. Automatic continuation unavailable: ${err.message}`, 'warning'); return; }
    if (resumeCount >= cfg.maxResumesPerEpisode) {
      status(ctx, 'Automatic quota recovery stopped: accepted-attempt limit reached.');
      if (!limitReported) notify(ctx, 'No next automatic continuation: the accepted-attempt limit was reached. Use /quota-resume check or retry manually.');
      limitReported = true;
      return;
    }
    const key = modelKey(nativeSession(ctx).model ?? ctx.model);
    const hinted = [parseResetHint(errorText), restored?.hintResetAt,
      lastResetHint?.sessionId === sessionId(ctx) && lastResetHint.modelKey === key ? lastResetHint.at : null]
      .filter((at) => Number.isFinite(at) && at > 0);
    const time = hinted.length ? Math.max(...hinted) : null;
    const gen = ++generation;
    clearTimer();
    context = ctx;
    pending = {
      provider, sessionId: sessionId(ctx), modelKey: key,
      detectedAt: Number.isFinite(restored?.detectedAt) ? restored.detectedAt : Date.now(),
      resetAt: Number.isFinite(restored?.resetAt) ? restored.resetAt : time,
      hintResetAt: time, resumeAt: null, nextCheckAt: null, lastProbeError: null,
      ready: false, recovered: false, dispatching: false,
    };
    persistWait();
    status(ctx, 'Quota limit detected; checking the recovery schedule.');
    // Publish exactly one notice after the initial request resolves; never retry inside this hook.
    await probe(gen, false);
  }

  async function restoreWait(ctx) {
    if (!cfg.enabled) return;
    const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
    let restored = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'custom' && entries[i].customType === STATE_TYPE) { restored = entries[i].data; break; }
    }
    if (restored && (restored.version !== 1 || !['waiting', 'retrying'].includes(restored.state)
      || restored.sessionId !== sessionId(ctx) || restored.modelKey !== modelKey(ctx.model))) return;
    const error = asError(lastConversationMessage(ctx));
    if (!error) return;
    if (restored) {
      resumeCount = Number.isInteger(restored.attempts) ? Math.max(0, restored.attempts) : 0;
      episodeAnnounced = restored.announced === true;
      savedState = JSON.stringify(restored);
    }
    // Also recover pre-0.3.0 sessions whose failed quota tail predates recovery metadata.
    await startWait(ctx, error, restored);
  }

  function noticeError(message, ctx) {
    const error = asError(message);
    if (error) lastError = { text: error, sessionId: sessionId(ctx), modelKey: modelKey(ctx.model) };
    else if (message?.role === 'assistant') lastError = null;
  }
  function rememberHint(ctx, at) {
    if (!Number.isFinite(at) || at <= 0) return;
    const key = modelKey(ctx.model);
    const same = lastResetHint?.sessionId === sessionId(ctx) && lastResetHint.modelKey === key;
    lastResetHint = { sessionId: sessionId(ctx), modelKey: key, at: same ? Math.max(lastResetHint.at, at) : at };
    if (pending && pending.sessionId === sessionId(ctx) && pending.modelKey === key) {
      pending.hintResetAt = Math.max(pending.hintResetAt ?? 0, at);
      if (!pending.resetAt) pending.resetAt = at;
      if (!pending.ready && pending.resetAt) {
        pending.resumeAt = Math.max(pending.detectedAt + cfg.minResumeDelaySeconds * 1000, pending.resetAt + cfg.resetSlackSeconds * 1000);
        scheduleNext();
        if (episodeAnnounced) reportSchedule(ctx);
      }
      persistWait();
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    cfg = loadConfig(configPath);
    cancel(ctx, '', false);
    context = ctx;
    activeSessionId = sessionId(ctx);
    lastQuota = null;
    savedState = null;
    await restoreWait(ctx);
  });
  pi.on('session_shutdown', (_event, ctx) => { cancel(ctx, '', false); context = null; });
  pi.on('session_switch', async (_event, ctx) => {
    if (activeSessionId === sessionId(ctx)) return;
    cancel(ctx, '', false);
    context = ctx;
    activeSessionId = sessionId(ctx);
    savedState = null;
    lastQuota = null;
    await restoreWait(ctx);
  });
  pi.on('model_select', (_event, ctx) => { lastQuota = null; if (pending) cancel(ctx, 'The model changed.'); });
  pi.on('input', (event, ctx) => {
    if (event.source !== 'extension') cancel(ctx, pending ? 'New user input received.' : '');
  });
  pi.on('after_provider_response', (event, ctx) => {
    if (event.status !== 429) return;
    const value = headerValue(event.headers, 'retry-after');
    if (!value) return;
    const seconds = Number(value);
    rememberHint(ctx, Number.isFinite(seconds) && seconds >= 0 ? Date.now() + seconds * 1000 : Date.parse(value));
  });
  pi.on('auto_retry_end', (event, ctx) => {
    if (event.success !== false || !isQuotaError(event.finalError)) return;
    // OMP may learn a multi-hour wait after the assistant error was already finalized.
    rememberHint(ctx, parseResetHint(event.finalError));
  });
  pi.on('message_end', (event, ctx) => noticeError(event.message, ctx));
  pi.on('turn_end', (event, ctx) => noticeError(event.message, ctx));
  pi.on('agent_end', async (event, ctx) => {
    const message = event.messages?.findLast((item) => item?.role === 'assistant');
    if (message?.stopReason === 'aborted') { cancel(ctx); return; }
    if (message) noticeError(message, ctx);
    if (event.willContinue || event.willRetry || !cfg.enabled) return;
    if (pending) {
      if (message && !asError(message)) cancel(ctx);
      else if (pending.ready) schedule(500);
      return;
    }
    if (!lastError) { cancel(ctx); return; }
    const error = lastError;
    lastError = null;
    if (error.sessionId !== sessionId(ctx) || error.modelKey !== modelKey(ctx.model)) return;
    await startWait(ctx, error.text);
  });

  pi.registerCommand('quota-resume', {
    description: 'Codex / Claude Code quota monitor: status | check | on | off | cancel | interval <minutes; 0 disables periodic checks>',
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
        if (!Number.isFinite(minutes) || (minutes !== 0 && (minutes < 0.25 || minutes > 60))) {
          notify(ctx, 'Use interval 0 to disable periodic checks, or 0.25–60 minutes; default: 30.', 'warning'); return;
        }
        cfg.pollMinutes = minutes;
        saveConfig();
        if (pending) { scheduleNext(); reportSchedule(ctx); }
        notify(ctx, `Background polling: ${minutes ? `every ${minutes} minutes` : 'off; known reset checks and manual checks remain enabled'}.`);
      } else if (cmd === 'check') {
        if (pending) { await probe(generation); if (pending) notify(ctx, `${fmtQuota(lastQuota)} ${timing()}${pending.lastProbeError ? ` Last check: ${pending.lastProbeError}` : ''}`); }
        else {
          try { lastQuota = await fetchQuota(ctx); notify(ctx, fmtQuota(lastQuota)); }
          catch (err) { notify(ctx, `Quota check failed: ${String(err?.message || err)}`, 'warning'); }
        }
      } else if (cmd === 'status') {
        notify(ctx, `Automatic continuation: ${cfg.enabled ? 'on' : 'off'}. ${pending ? timing() : `No pending continuation. Background polling: ${cfg.pollMinutes ? `${cfg.pollMinutes} minutes` : 'off'}.`} Attempts: ${resumeCount}/${cfg.maxResumesPerEpisode}. ${fmtQuota(lastQuota)}${pending?.lastProbeError ? ` Last check: ${pending.lastProbeError}` : ''}`);
      } else {
        notify(ctx, 'Usage: /quota-resume status | check | on | off | cancel | interval 30 | interval 0', 'warning');
      }
    },
  });
}
