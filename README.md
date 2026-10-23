# Pi Quota Auto Continue

Message-free Codex subscription quota recovery for **Oh My Pi (OMP)**. When a task stops on a quota error, the extension monitors the current account's quota windows and retries the interrupted turn using OMP's native retry mechanism. It never sends a `continue` prompt or adds a hidden custom message.

[npm package](https://www.npmjs.com/package/pi-quota-auto-continue) · [Source code](https://github.com/vanxxxx/pi-quota-auto-continue) · [Report an issue](https://github.com/vanxxxx/pi-quota-auto-continue/issues)

## Features

- Native retry in the original session, without adding conversation messages.
- Notifications showing the estimated next automatic continuation time, or an explicit unknown time when the provider supplies no usable reset information.
- Silent background quota checks every **10 minutes** by default, plus a check at the estimated reset time.
- Early recovery detection, including an account becoming available before its previously reported reset time.
- Five-hour and weekly quota windows, with model-specific quota buckets when provided.
- No npm dependencies, extra plugins, build step, or separate background service.

## Requirements and Compatibility

- **OMP 18.12.1**, or a compatible OMP release exposing `pi.pi.AgentRegistry` and native `AgentSession.retry()`. Version 18.12.1 was exercised locally.
- A current OpenAI Codex model authenticated through subscription OAuth and using the official `https://chatgpt.com` origin.
- A running OMP session. Monitoring does not survive process exit.
- Node.js **22.6 or newer** for the development commands below. OMP's bundled runtime loads the extension itself.

**Stock Pi compatibility:** the package includes Pi-style discovery metadata, but stock Pi's extension API does not expose the OMP registry/native retry bridge used here. Automatic continuation is therefore not supported on stock Pi. Unsupported hosts report the limitation rather than falling back to a user message or a hidden message.

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
omp -e ./node_modules/pi-quota-auto-continue
```

Run both commands from the same project directory. To enable it persistently, add the installed package's absolute directory path to the `extensions` array in the active OMP profile's `config.yml`, then restart OMP. No global npm installation is required.

### From a source checkout

Run from the project directory:

```sh
omp -e ./src/index.ts
```

No `npm install` is required. To enable a checkout persistently, add its absolute directory path to the `extensions` array in the active OMP profile's `config.yml` and restart OMP. The package manifest resolves the entry to `src/index.ts`.

## Usage

1. Log in to Codex using OMP's normal OAuth login and select an official Codex model.
2. Run a task normally. Only a failed assistant turn containing a recognized quota error arms automatic recovery; ordinary assistant text mentioning a quota does not.
3. Keep OMP running. The extension reports the estimated continuation time, monitors availability, and schedules native retry once recovery is confirmed.

Notifications and footer status are UI-only; they are not sent to the model. In headless mode, notifications are printed with a `[quota-auto-continue]` prefix. Unchanged background checks produce no notification or console message.

### Commands

| Command | Action |
| --- | --- |
| `/quota-resume status` | Show pending continuation/check times, attempt count, latest usage, and the last check error. |
| `/quota-resume check` | Check usage immediately; retry if a waiting task is eligible and quota has recovered. |
| `/quota-resume interval 10` | Set the background interval to 10 minutes; accepted range: 0.25–60. |
| `/quota-resume on` | Enable automatic recovery for subsequent quota failures. |
| `/quota-resume off` | Disable automatic recovery and cancel the current wait. |
| `/quota-resume cancel` | Cancel only the current recovery episode. |

## Configuration

Configuration lives at `quota-auto-continue.json` inside the active agent directory. By default this is `~/.omp/agent/quota-auto-continue.json`; named profiles use their own agent directory. `PI_CODING_AGENT_DIR`, when set, overrides this extension's configuration directory.

Use [`examples/quota-auto-continue.json`](examples/quota-auto-continue.json) as the starting configuration. The `on`, `off`, and `interval` commands save settings atomically. Restart OMP after editing the JSON externally.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable recovery after a quota failure. |
| `pollMinutes` | `10` | Background check interval, from 0.25 to 60 minutes. |
| `resetSlackSeconds` | `5` | Extra time after a reported reset before the scheduled reset check. |
| `minResumeDelaySeconds` | `20` | Minimum delay after detection before retry; accepted range: 5–600 seconds. |
| `maxResumesPerEpisode` | `3` | Maximum native retry attempts across consecutive quota failures; accepted range: 1–20. |
| `resumeAtHintIfUsageUnavailable` | `true` | Allow a bounded retry after an explicit reset hint when the usage endpoint cannot be queried. Set `false` to require confirmed availability. |

The old `continuationPrompt` setting is no longer read or saved. Existing saved polling intervals remain in effect; use `/quota-resume interval 10` to adopt the new default in an existing installation.

## Recovery Behavior

1. Wait for a terminal `agent_end` notification. OMP-managed intermediate recoveries are left to the host.
2. Validate the provider and OAuth authentication, then query `https://chatgpt.com/backend-api/wham/usage` using runtime credentials supplied by the host.
3. Interpret windows by their duration, not their field order. A matching model-specific bucket takes precedence. When both five-hour and weekly windows are exhausted, use the later reset as the estimate.
4. Report the estimated next continuation time and next check time. If the reset is unknown, explicitly report that the continuation time is unknown. Times use the machine's local time zone.
5. Check silently every 10 minutes by default, or sooner when a known reset plus slack is due. An early provider/account reset can therefore be discovered without waiting for the original reset estimate. A changed continuation estimate is announced; unchanged polls remain silent.
6. Once availability is confirmed and the minimum delay has elapsed, announce the current retry time, revalidate session ownership, and call the live session's native `retry()`. The host schedules the continuation; accepting retry is not a guarantee that the next provider request succeeds.
7. If quota blocks the next turn again, report a new schedule. Stop at the configured attempt limit. Successful completion, new user input, session replacement, model changes, explicit cancellation, or shutdown clear the recovery episode as applicable.

With hint fallback enabled, an unavailable usage endpoint may allow retry at an explicit error/HTTP reset hint, never earlier than a previously observed blocking reset or the minimum delay. This is announced as a hint-based retry, not as confirmed recovery. Without usage data or a reset hint, monitoring continues but no blind retry is sent.

## Security and Limitations

- Tokens are obtained through the host's model registry, never by reading `auth.json`. They are sent only to the fixed official HTTPS usage endpoint, with redirects disabled and a 15-second timeout. Credentials are not stored or logged by this extension.
- API-key accounts, proxy origins, and other vendors are not supported. A quota response describes the current account/model; it cannot establish that a reset affected every account globally. The extension detects availability changes, not the vendor's internal reason for them.
- The usage endpoint is an undocumented ChatGPT endpoint and may change. Failed checks remain silent in the background and can be inspected with `/quota-resume status`.
- Native retry uses the same session and does not add a prompt, but it still makes a new provider request and can consume quota. The host controls failed-turn normalization and tool replay; exactly-once external side effects are not guaranteed.
- OMP's exported registry/session bridge is host-specific, not a portable Pi extension API. A missing bridge or a declined native retry is reported without synthesizing a message.
- Timers are in-memory and do not keep a headless process alive. This package does not restart OMP or recover a wait after OMP has exited.

## Development

```sh
npm test
npm run pack:check
```

Tests use Node's built-in runner and fake timers; no network access or installed dependencies are required. GitHub Actions runs the test suite and checks the npm package contents on Node 22.6.0, 22.x, and 24.x.

The native host integration was also exercised with the local OMP 18.12.1 executable and a credential-free synthetic provider: one quota failure, one native retry, one successful response, one original user message, and zero custom messages. This verifies host integration, not live ChatGPT endpoint availability.

### Project Structure

```text
src/
  index.ts                        Extension lifecycle, monitoring, notifications, native retry
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
- [Pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)
