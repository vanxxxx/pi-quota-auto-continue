# Pi Quota Auto Continue

Message-free **Codex and Claude Code** subscription quota recovery for **Oh My Pi (OMP)**. When a task stops on a quota error, the extension monitors the current account's quota windows and retries the interrupted turn using OMP's native retry mechanism. It never sends a `continue` prompt or adds a hidden custom message.

[npm package](https://www.npmjs.com/package/pi-quota-auto-continue) · [Source code](https://github.com/vanxxxx/pi-quota-auto-continue) · [Report an issue](https://github.com/vanxxxx/pi-quota-auto-continue/issues)

## Features

- Native retry in the original session, without adding conversation messages.
- One consolidated quota notice per interruption episode; later schedule changes update status silently.
- Silent background quota checks every **30 minutes** by default; `interval 0` disables recurring checks while preserving a known reset deadline.
- Early recovery detection, including an account becoming available before its previously reported reset time.
- Five-hour and weekly subscription windows, including the applicable Claude model-family limits.
- No npm dependencies, extra plugins, build step, or separate background service.

## Requirements and Compatibility

- **OMP 18.12.1**, or a compatible OMP release exposing `pi.pi.AgentRegistry` and native `AgentSession.retry()`. Version 18.12.1 was exercised locally.
- A current Codex or Anthropic Claude model authenticated through subscription OAuth and using its official provider origin.
- A running OMP session for timers. Reopening the same failed session restores saved recovery state and checks availability again.
- Node.js **22.6 or newer** for the development commands below. OMP's bundled runtime loads the extension itself.

**Stock Pi compatibility:** the package includes Pi-style discovery metadata, but stock Pi's extension API does not expose the OMP registry/native retry bridge used here. Automatic continuation is therefore not supported on stock Pi. Unsupported hosts report the limitation rather than falling back to a user message or a hidden message.

### Supported Subscriptions

| Subscription | OMP provider | Required model origin | Usage endpoint |
| --- | --- | --- | --- |
| OpenAI Codex | `openai-codex` / OAuth-backed `openai` | `https://chatgpt.com` | `https://chatgpt.com/backend-api/wham/usage` |
| Claude Code | `anthropic` | `https://api.anthropic.com` | `https://api.anthropic.com/api/oauth/usage` |

Claude Code support means the Claude subscription configured in OMP with Claude Code OAuth credentials. It does not control independent `claude` CLI processes, redeem saved reset credits, buy additional quota, or enable extra usage. It waits for a provider reset or earlier confirmed recovery, then retries the interrupted OMP task. Regular Anthropic API keys are rejected even when the account also has a saved OAuth login.

## Install Command

Install the [npm package](https://www.npmjs.com/package/pi-quota-auto-continue) through OMP:

```sh
omp install pi-quota-auto-continue
```

Restart OMP after installation. Installing the package through OMP makes its extension entry discoverable; `npm install` alone does not enable it in an OMP session.

### Install with npm

Alternatively, install the package into a local project and load it explicitly:

```sh
npm install pi-quota-auto-continue
omp --no-extensions -e ./node_modules/pi-quota-auto-continue
```

Run both commands from the same project directory. This isolated launch disables ambient extension discovery so an older installed copy cannot load alongside the local package. For normal persistent use with your other extensions, prefer `omp install pi-quota-auto-continue`. No global npm installation is required.

### From a source checkout

Run from the project directory:

```sh
omp --no-extensions -e ./src/index.ts
```

No `npm install` is required. For persistent local development, run `omp plugin link .` from this directory; it replaces the installed copy of this package with a link to the checkout. Restart OMP, and keep the checkout available. Do not load both an installed and an explicit copy of this extension at the same time.

## Usage

1. Log in to Codex or Anthropic using OMP's normal subscription OAuth login and select a model using that provider's official origin.
2. Run a task normally. Only a failed assistant turn containing a recognized quota error arms automatic recovery; ordinary assistant text mentioning a quota does not.
3. Keep OMP running. The extension reports the estimated continuation time, monitors availability, and schedules native retry once recovery is confirmed.

Notifications and footer status are UI-only; they are not sent to the model. In headless mode, notifications are printed with a `[quota-auto-continue]` prefix. Unchanged background checks produce no notification or console message.

### Commands

| Command | Action |
| --- | --- |
| `/quota-resume status` | Show pending continuation/check times, attempt count, latest usage, and the last check error. |
| `/quota-resume check` | Check usage immediately; retry if a waiting task is eligible and quota has recovered. |
| `/quota-resume interval 30` | Set the background interval to 30 minutes; accepted nonzero range: 0.25–60. |
| `/quota-resume interval 0` | Disable recurring background checks; keep manual checks and a known one-shot reset check. |
| `/quota-resume on` | Enable automatic recovery for subsequent quota failures. |
| `/quota-resume off` | Disable automatic recovery and cancel the current wait. |
| `/quota-resume cancel` | Cancel only the current recovery episode. |

## Configuration

Configuration lives at `quota-auto-continue.json` inside the active agent directory. By default this is `~/.omp/agent/quota-auto-continue.json`; named profiles use their own agent directory. `PI_CODING_AGENT_DIR`, when set, overrides this extension's configuration directory.

Use [`examples/quota-auto-continue.json`](examples/quota-auto-continue.json) as the starting configuration. The `on`, `off`, and `interval` commands save settings atomically. Restart OMP after editing the JSON externally.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable recovery after a quota failure. |
| `pollMinutes` | `30` | Background interval: `0` disables periodic checks, otherwise 0.25–60 minutes. |
| `resetSlackSeconds` | `5` | Extra time after a reported reset before the scheduled reset check. |
| `minResumeDelaySeconds` | `20` | Minimum delay after detection before retry; accepted range: 5–600 seconds. |
| `maxResumesPerEpisode` | `3` | Maximum accepted native retry attempts across consecutive quota failures; temporary host refusal does not consume an attempt. Accepted range: 1–20. |
| `resumeAtHintIfUsageUnavailable` | `true` | Allow a bounded retry after an explicit reset hint when the usage endpoint cannot be queried. Set `false` to require confirmed availability. |

The old `continuationPrompt` setting is no longer read or saved. Existing saved polling intervals remain in effect; use `/quota-resume interval 30` to adopt the new default, or `/quota-resume interval 0` to turn periodic checks off.

Provider selection is automatic from the current model; the same settings and commands apply to Codex and Claude Code. No new configuration keys or dependencies are required.

## Recovery Behavior

1. Wait for a terminal `agent_end` notification. OMP-managed intermediate recoveries are left to the host.
2. Validate the selected provider, official origin, and OAuth credential, then query its fixed usage endpoint. Claude requests use bearer authentication and the `oauth-2025-04-20` protocol beta. Credentials and arbitrary model headers are never forwarded to another host.
3. For Codex, interpret windows by duration rather than field order; a matching model-specific bucket takes precedence. For Claude, require valid shared five-hour and weekly usage, and also honor the current model family's weekly cap. Both legacy `seven_day_sonnet` / `seven_day_opus` fields and current `limits[]` rows (`session`, `weekly_all`, `weekly_scoped`) are understood. A scoped row's `is_active` flag does not remove that limit. Unknown model families or unrecognized scope labels are handled conservatively. Use the latest reset among exhausted applicable windows; another known model family's cap does not block the selected family.
4. Combine the failed turn, host retry/reset hints, and the initial usage result into one quota notice. If the reset is unknown, say so explicitly. Times use the machine's local time zone; later changes update footer/status and `/quota-resume status`, not another warning.
5. Check silently every 30 minutes by default, or sooner when a known reset plus slack is due. With interval `0`, no recurring checks run: an already known reset still gets one check, and `/quota-resume check` remains available. If that check still shows exhaustion without a new future reset, wait for a manual check rather than spin.
6. Once availability is confirmed and the minimum delay has elapsed, revalidate live session/model ownership and request native `retry()`. Announce continuation only when the host accepts it. If the host is busy, retrying, compacting, or temporarily refuses admission, retain the wait and retry admission later without querying the provider again.
7. If quota blocks the accepted retry again, update the pending schedule silently. Stop at the configured accepted-attempt limit. Success, new user input, a different model, or explicit cancellation end the episode. Closing OMP stops timers but preserves small, credential-free recovery metadata in the session; reopening the same failed session restores it. Explicit cancellation is also saved, so reopening cannot undo it.

With hint fallback enabled, an unavailable usage endpoint may allow retry at an explicit error/HTTP reset hint, never earlier than a previously observed blocking reset or the minimum delay. This is announced as a hint-based retry, not as confirmed recovery. Without usage data or a reset hint, monitoring continues but no blind retry is sent.

OMP 18.12.1 may separately display `Retry failed ... Provider requested ... exceeds retry.maxDelayMs` before handing control back to the session. That is the host's native retry policy, not an extension timer failure. This extension reads the reported provider wait and owns the later recovery schedule; it does not raise the global retry delay cap, hide the original error, or disable ordinary network/5xx retries.

## Security and Limitations

- Tokens are obtained through the host's model registry, never by reading `auth.json`. They are sent only to the fixed official HTTPS usage endpoint, with redirects disabled and a 15-second timeout. Credentials are not stored or logged by this extension.
- Regular API-key accounts, proxy origins, and vendors other than the two listed above are not supported. A quota response describes the current account/model; it cannot establish that a reset affected every account globally. The extension detects availability changes, not the vendor's internal reason for them.
- Both subscription usage endpoints may change without notice. Missing or malformed Claude utilization is not treated as recovered quota, and paid extra-usage fields are not used to authorize retry. Failed checks remain silent in the background and can be inspected with `/quota-resume status`.
- Native retry uses the same session and does not add a prompt, but it still makes a new provider request and can consume quota. The host controls failed-turn normalization and tool replay; exactly-once external side effects are not guaranteed.
- OMP's exported registry/session bridge is host-specific, not a portable Pi extension API. Unsupported hosts report the limitation; temporary native retry refusal retains the interrupted task instead of losing it.
- Timers do not keep a headless process alive and do not restart OMP. Recovery can resume only after the same saved session is reopened. Older sessions without extension metadata can be re-armed only when their latest conversational turn is a genuine quota error; a new user turn, success, or saved cancellation prevents replay.

## Performance

- No quota HTTP requests or timers while there is no pending quota interruption.
- At most one pending timer and one in-flight quota probe per session. Unchanged schedules do not append new session metadata or emit notifications.
- During a full day of unchanged exhaustion with no earlier reset, the default interval makes 48 periodic checks plus the initial check, rather than the previous 144 plus the initial check.
- Interval `0` makes only the initial check unless a known reset becomes due or the user requests a manual check. With no reset hint, it leaves no active timer.
- Host-admission deferrals reuse the confirmed recovery result and do not repeatedly query usage. These numbers concern this extension; OMP's own usage polling is separate.

## Development

```sh
npm test
npm run pack:check
```

Tests use Node's built-in runner and fake timers; no network access or installed dependencies are required. GitHub Actions runs the test suite and checks the npm package contents on Node 22.6.0, 22.x, and 24.x.

Native host integration was exercised with the local OMP 18.12.1 executable and credential-free synthetic Codex and Claude providers. Each recovered after one quota failure with one quota notice, one accepted native retry, one original user message, and zero custom messages. A separate two-process test saved a failed session, closed OMP, reopened that session, and recovered without new user input or a repeated quota notice. The Claude flow was also exercised in the actual terminal UI. These checks verify host integration, not live provider usage-endpoint availability.

### Project Structure

```text
src/
  index.ts                        Extension lifecycle, monitoring, notifications, native retry
  quota-provider.mjs              Official-origin Codex and Claude OAuth usage requests
  quota-core.mjs                  Quota parsing and reset hints
examples/
  quota-auto-continue.json         Supported configuration settings
test/
  extension.test.mjs              Recovery scheduling and cancellation scenarios
  quota-core.test.mjs             Quota parsing scenarios
.github/workflows/ci.yml          Test and npm packaging checks
package.json                     Public package metadata and extension entries
README.md                        Installation, configuration, and release instructions
```

The npm package uses an explicit file allowlist: runtime source, the configuration example, package metadata, and this README. Tests, GitHub configuration, local credentials, and session files are not shipped.

## Publishing

Maintainer release instructions for `pi-quota-auto-continue`. Publishing requires npm package ownership and write access to the GitHub repository.

### npm

Review the package name/version and licensing before release, then run:

npm login alone is not sufficient for publishing. Enable two-factor authentication on the publishing account and complete the interactive challenge, or use a granular access token with package write permission and Bypass 2FA enabled. Keep tokens, one-time passwords, and recovery codes out of the repository.

```sh
npm login
npm test
npm run pack:check
npm publish --access public
```

`prepublishOnly` runs the tests again as a release gate. Update the package version before every subsequent release; npm versions cannot be overwritten.

### GitHub

Push source changes to [vanxxxx/pi-quota-auto-continue](https://github.com/vanxxxx/pi-quota-auto-continue):

```sh
git add .
git commit -m "Update quota recovery package"
git push origin main
```

The repository includes GitHub Actions checks for tests and npm package contents. The package manifest links npm users back to this repository and its issue tracker.

## License

No license is currently declared. Public availability alone does not grant permission to reuse or redistribute this code. The owner must explicitly choose licensing before granting those rights.

## References

- [OMP extension loading and package manifests](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md)
- [OMP 18.12.1 native turn recovery](https://github.com/can1357/oh-my-pi/blob/v18.12.1/packages/coding-agent/src/session/turn-recovery.ts)
- [OMP 18.12.1 Claude usage payloads](https://github.com/can1357/oh-my-pi/blob/v18.12.1/packages/ai/src/usage/claude.ts)
- [OMP 18.12.1 Claude OAuth account routes](https://github.com/can1357/oh-my-pi/blob/v18.12.1/packages/ai/src/usage/claude-api.ts)
- [Pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)
