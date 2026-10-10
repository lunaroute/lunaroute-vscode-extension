# Compatibility and release evidence

Status: **preview; not release-certified**. Source/unit checks, direct extension-host API checks, native Chat/Agent behavior, and deployed SaaS evidence are separate gates.

## Recorded evidence

| Date (UTC) | Environment / model | Expected | Actual / evidence |
| --- | --- | --- | --- |
| 2026-10-10 | Node unit tests; controlled HTTP/SSE; real OpenAI SDK 7.32.0 | Auth, catalog, Responses and provider contracts pass | 197 tests, typecheck and build passed before host checks. Unit VS Code shims are not host evidence. |
| 2026-10-10 | Desktop VS Code **1.141.0**, Linux x64, Xvfb, fresh user/extension directories, local empty workspace; synthetic `lunaroute-probe/probe-chat` | Stable API registration/classes, signed-out product commands and no credential-bearing exports | Passed in actual extension host. Product activation used production factories without overrides; only the separate test fixture received loopback endpoints and synthetic credentials. |
| 2026-10-10 | Same actual host, controlled fixture, no GitHub session | PKCE/SecretStorage events; model selection/counting; SDK text, multiple tools/results, images and opaque replay; caller cancellation, replacement and model changes | Passed through public `lm.selectChatModels` / `sendRequest`. Native model broker returned replay data and accepted it in a later direct request. No extension-side tool execution. This does **not** prove the built-in Chat/Agent caller preserves that history. |
| 2026-10-10 | SaaS draft PR [#1436](https://github.com/lunaroute/lunaroute-saas/pull/1436), commit `756858b09644e51b6581be4a8d21e6b9e00e5799` | Scoped auth/onboarding checks | Local Go/frontend gates and PR CI passed. **Not merged or deployed**; deployed-SHA evidence unavailable. |

The host run emitted VS Code startup diagnostics (unsigned-in GitHub/agent-host channels and a platform deprecation warning) and native cancellation diagnostics. The process exited 0 with all contract checkpoints passing. No real LunaRoute credentials, customer prompts or live gateway inference were used. Real SecretStorage API/events were exercised; this is not an OS-keyring encryption audit or a two-window test.

Local logs are in this plan's ignored `.superpowers/sdd/2026-10-09-lunaroute-vscode-extension/` workspace (`task-7-green-wiring.log`, `task-7-host-first.log` and subsequent host/check logs); they must not ship.

## Repeatable direct host checks

```sh
npm ci
npm run check
npm run build
# Desktop with an available display:
npm run test:host
# Linux headless with Xvfb:
xvfb-run -a npm run test:host
```

The runner downloads the pinned VS Code release, creates temporary user/extension/workspace directories, disables telemetry/updates in that test profile, and cleans the profile afterward. It never reads the user's product connection. The probe extension owns a separate SecretStorage namespace and uses only loopback fixtures. It is excluded from the VSIX.

On the initial Linux machine Xvfb was absent. An Ubuntu `xvfb` package was extracted under ignored `.vscode-test/xvfb/` and run with a command-local PATH; no system package was installed. Other machines should supply their normal display/Xvfb.

## Mandatory native Chat/Agent checkpoint — NOT RUN

Requires owner-authorized deployment of the scoped SaaS change and a disposable real test account/workspace. Record desktop version, OS/remote placement, model ID, date, deployed SHA, expected/actual result and redacted evidence for each item. Never record a credential, callback URL, prompt or conversation/tool contents.

- [ ] Baseline 1.141.0 native model picker finds the real authenticated catalog; pre-existing main and utility model preferences stay unchanged.
- [ ] Native Chat streams an answer; user cancellation stops inference.
- [ ] Native Agent performs a multi-step tool round trip with VS Code-owned approvals and workspace tool execution.
- [ ] Native Chat/Agent preserves required opaque reasoning, tool IDs/results and image history on the next turn. A direct API pass above is not sufficient.
- [ ] Unsupported PromptTsx/data/roles/replay fail explicitly. Unexpected native history requirements block the affected advertised capability; do not flatten or drop them by guesswork.
- [ ] Fresh profile without GitHub/Copilot sign-in: document whether native Chat/Agent works and any platform/policy prerequisite.
- [ ] Near-limit multilingual text, images and tool history: compare conservative estimates to actual model acceptance before advertising context capacity.
- [ ] Verify account creation/password/OAuth, cross-tab email verification, invite/CAPTCHA preservation, organization selection and plan/setup detours return to authorization.
- [ ] Blocked loopback/manual recovery and expired authorization recover through a fresh sign-in without key copying.
- [ ] Reload/restart reuses SecretStorage; local sign-out removes the saved connection but does not claim key revocation.
- [ ] Two-window sign-out/replacement, cancellation during exchange/storage/inference, and secure-storage failure show no stale success or response.
- [ ] Revoked key / 401, policy / 403, billing / 402, rate limit / 429 and network failures provide safe recovery without automatic inference/exchange retry or model fallback.

## Platform and package matrix — NOT RUN unless recorded above

| Platform / placement | Source host API | Packaged install | Native Chat/Agent + auth |
| --- | --- | --- | --- |
| Linux desktop local UI | Passed, 1.141.0 | Pending | Pending |
| macOS desktop local UI | Pending | Pending | Pending |
| Windows desktop local UI | Pending | Pending | Pending |
| Remote SSH, local UI extension | Pending | Pending | Pending |
| WSL, local UI extension | Pending | Pending | Pending |
| Dev Container, local UI extension | Pending | Pending | Pending |

Browser-only VS Code and remote workspace extension-host placement are deliberately unsupported. Unit placement checks are not a remote smoke test. Marketplace publisher/repository ownership, publication authority, cross-platform/remote checks, packaged installation and live native compatibility remain release gates.
