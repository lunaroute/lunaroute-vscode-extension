# Compatibility and release evidence

Status: **preview; not release-certified**. Source/unit checks, direct extension-host API checks, native Chat/Agent behavior, and deployed SaaS evidence are separate gates.

## Recorded evidence

| Date (UTC) | Environment / model | Expected | Actual / evidence |
| --- | --- | --- | --- |
| 2026-10-10 | Node 24.21.0 / npm 11.19.0; controlled HTTP/SSE; real OpenAI SDK 7.32.0 | Auth, catalog, Responses and provider contracts pass | 199 tests, typecheck and build passed before host checks. Unit VS Code shims are not host evidence. |
| 2026-10-10 | Desktop VS Code **1.141.0**, Linux x64, Xvfb, fresh user/extension directories, local empty workspace; synthetic `lunaroute-probe/probe-chat` | Stable API registration/classes, signed-out product commands and no credential-bearing exports | Passed in actual extension host. Product activation used production factories without overrides; only the separate test fixture received loopback endpoints and synthetic credentials. |
| 2026-10-10 | Same actual host, controlled fixture, no GitHub session | PKCE/SecretStorage events; model selection/counting; SDK text, multiple tools/results, images and opaque replay; caller cancellation, replacement and model changes | Passed through public `lm.selectChatModels` / `sendRequest`. Native model broker returned replay data and accepted it in a later direct request. No extension-side tool execution. This does **not** prove the built-in Chat/Agent caller preserves that history. |
| 2026-10-10 | SaaS draft PR [#1436](https://github.com/lunaroute/lunaroute-saas/pull/1436), commit `756858b09644e51b6581be4a8d21e6b9e00e5799` | Scoped auth/onboarding checks | Local Go/frontend gates and PR CI passed. **Not merged or deployed**; deployed-SHA evidence unavailable. |

Final local extension gates were repeated with the planned Node 24 toolchain, extracted under ignored \`.vscode-test/node24/\` after verifying the official SHA-256 manifest; earlier Node 22 runs were preliminary. The inspected VSIX SHA-256 was \`3b9401d045bf61eb59974399f8c80128cb658684c378acd222d60708c4272824\` (ZIP timestamps mean a new package run can change that archive hash).

The host run emitted VS Code startup diagnostics (unsigned-in GitHub/agent-host channels and a platform deprecation warning) and native cancellation diagnostics. The process exited 0 with all contract checkpoints passing. No real LunaRoute credentials, customer prompts or live gateway inference were used. Real SecretStorage API/events were exercised; this is not an OS-keyring encryption audit or a two-window test.

The Linux packaged extension was also installed from the inspected VSIX into a disposable profile on 2026-10-10. The host asserted that the product loaded from that installation rather than development sources, then verified signed-out activation, commands and provider registration. Remaining model/transport contracts still used the separate development probe; this is not a packaged live-login/inference claim. The archive contains exactly seven files (VSIX metadata, manifest, runtime, README, MIT license and third-party notices); fixture/credential-canary and full-license checks passed. Negative archive checks rejected an extra fixture, a credential-shaped canary and missing license text.

SaaS gates were rerun on 2026-10-10: Go passed (cached test results), frontend 239 files / 2408 tests passed, typecheck/build passed. Lint exited 0 with **23 pre-existing warnings**, not a warning-free result; four existing jsdom navigation warnings remain. The warning files are unchanged from SaaS base \`c02f6e71\`. Extension \`npm ci\` reported zero vulnerabilities. These initial local checks predated the GitHub repository. The repository is now [lunaroute/lunaroute-vscode-extension](https://github.com/lunaroute/lunaroute-vscode-extension); actual hosted checks are reported in [Actions](https://github.com/lunaroute/lunaroute-vscode-extension/actions/workflows/check.yml), not inferred from local results. Repository bootstrap updated the copyright to LunaRoute, Inc. and repeated all 199 tests, packaging/archive checks and the installed-VSIX Linux host checks; logs are `repository-*.log` in the plan workspace.

Local logs are in this plan's ignored `.superpowers/sdd/2026-10-09-lunaroute-vscode-extension/` workspace (`task-7-green-wiring.log`, `task-7-host-first.log` and subsequent host/check logs); they must not ship.

## Final source review

One fresh-context, read-only reviewer inspected both source ranges through extension `6e2d420` and SaaS `756858b`. The parent then made the planned single TDD correction pass:

- Cancellation now waits for secure mutation/cleanup settlement and reports storage failure instead of ordinary cancellation. Failed-write ownership permits explicit Sign Out recovery without activating that credential; an obsolete failure cannot clear a newer observed connection. The regressions were observed RED then GREEN, including a generation-guard mutation check.
- The archive scanner now detects the actual user-key format (`lr_` plus 64 hexadecimal characters). An otherwise-valid archive containing a synthetic key of that shape was accepted before the fix and rejected afterward. This negative check now runs in packaging CI; no real credential was found in the earlier artifact.

After the corrections: **199/199 tests**, typecheck/build/package, normal and negative archive checks, both actual Linux host modes, and uncached focused Go authorization/exchange tests passed. Logs are `final-*.log` in the corresponding plan workspaces. The reviewer did not execute tests; this is parent verification, not a second independent review.

**Deferred minors:** the extension sends `hostname` where exchange expects `label`, leaving generic dashboard key names; malformed catalog rows are safely excluded but lack sanitized rejection diagnostics. These remain open, not silently fixed.

Storage failure can still leave a saved key until storage is repaired and Sign Out succeeds or the key is revoked. Cancellation may wait for the platform storage call; this does not claim cross-process atomicity. All live/platform/ownership release gates below remain open.

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
| Linux desktop local UI | Passed, 1.141.0 | Passed, signed-out activation/commands on 1.141.0 | Pending |
| macOS desktop local UI | Pending | Pending | Pending |
| Windows desktop local UI | Pending | Pending | Pending |
| Remote SSH, local UI extension | Pending | Pending | Pending |
| WSL, local UI extension | Pending | Pending | Pending |
| Dev Container, local UI extension | Pending | Pending | Pending |

Browser-only VS Code and remote workspace extension-host placement are deliberately unsupported. Unit placement checks are not a remote smoke test. Marketplace publisher/repository ownership, publication authority, cross-platform/remote checks, packaged live-login/inference and live native compatibility remain release gates.
