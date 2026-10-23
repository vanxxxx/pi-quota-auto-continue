/** Official-origin subscription quota requests; credentials stay inside the host process. */
import { extractQuota, extractClaudeQuota } from './quota-core.mjs';

export class UnsupportedQuotaProviderError extends Error {}

export function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') return value;
  }
  return undefined;
}

export function checkProvider(ctx) {
  const model = ctx.model;
  const claude = model?.provider === 'anthropic';
  if (!model || (!claude && !['openai-codex', 'openai'].includes(model.provider)) || !ctx.modelRegistry?.isUsingOAuth?.(model)) {
    throw new UnsupportedQuotaProviderError('The current model must use Codex or Claude Code subscription OAuth.');
  }
  let base;
  try { base = new URL(model.baseUrl); } catch { throw new UnsupportedQuotaProviderError('Cannot verify the provider origin.'); }
  const hostname = claude ? 'api.anthropic.com' : 'chatgpt.com';
  if (base.protocol !== 'https:' || base.hostname !== hostname || base.port || base.username || base.password) {
    throw new UnsupportedQuotaProviderError(`Quota monitoring requires the official https://${hostname} origin.`);
  }
  return claude ? 'Claude Code' : 'Codex';
}

function accountIdFromJwt(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    const account = payload['https://api.openai.com/auth']?.chatgpt_account_id ?? payload.chatgpt_account_id;
    return typeof account === 'string' && /^[a-zA-Z0-9_-]{5,128}$/.test(account) ? account : undefined;
  } catch { return undefined; }
}

export async function fetchQuota(ctx) {
  const provider = checkProvider(ctx);
  const model = ctx.model;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth?.ok) throw new Error('No active OAuth credential is available.');
  const bearer = headerValue(auth.headers, 'authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const accessToken = typeof auth.apiKey === 'string' && auth.apiKey ? auth.apiKey : bearer;
  if (!accessToken) throw new Error('No active OAuth credential is available.');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  // A saved OAuth account does not prove the selected credential is OAuth.
  if (provider === 'Claude Code' && !accessToken.includes('sk-ant-oat')) {
    throw new UnsupportedQuotaProviderError('The selected Anthropic credential is not a Claude Code OAuth token.');
  }
  let endpoint;
  if (provider === 'Claude Code') {
    endpoint = 'https://api.anthropic.com/api/oauth/usage';
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['User-Agent'] = 'pi-quota-auto-continue';
  } else {
    endpoint = 'https://chatgpt.com/backend-api/wham/usage';
    const accountId = headerValue(auth.headers, 'chatgpt-account-id') ?? accountIdFromJwt(accessToken);
    if (accountId && /^[a-zA-Z0-9_-]{5,128}$/.test(accountId)) headers['ChatGPT-Account-Id'] = accountId;
  }
  // Never forward credentials to a proxy, follow redirects, or log tokens.
  const response = await fetch(endpoint, {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${provider} quota endpoint HTTP ${response.status}`);
  const payload = await response.json();
  const quota = provider === 'Claude Code'
    ? extractClaudeQuota(payload, String(model.id ?? ''))
    : extractQuota(payload, String(model.id ?? ''));
  if (!quota) throw new Error('The provider returned no recognizable quota windows.');
  return { ...quota, provider };
}
