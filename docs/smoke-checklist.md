# Compatibility and release evidence

Status: **preview; not release-certified**. Source/unit checks, direct extension-host API checks, native Chat/Agent behavior, and deployed SaaS evidence are separate gates.

## Recorded evidence

| Date (UTC) | Environment / model | Expected | Actual / evidence |
| --- | --- | --- | --- |
| 2026-10-10 | Node 24.21.0 / npm 11.19.0; controlled HTTP/SSE; real OpenAI SDK 7.32.0 | Auth, catalog, Responses and provider contracts pass | 199 tests, typecheck and build passed before host checks. Unit VS Code shims are not host evidence. |
| 2026-10-10 | Desktop VS Code **1.141.0**, Linux x64, Xvfb, fresh user/extension directories, local empty workspace; synthetic `lunaroute-probe/probe-chat` | Stable API registration/classes, signed-out product commands and no credential-bearing exports | Passed in actual extension host. Product activation used production factories without overrides; only the separate test fixture received loopback endpoints and synthetic credentials. |
| 2026-10-10 | Same actual host, controlled fixture, no GitHub session | PKCE/SecretStorage events; model selection/counting; SDK text, multiple tools/results, images and opaque replay; caller cancellation, replacement and model changes | Passed through public `lm.selectChatModels` / `sendRequest`. Native model broker returned replay data and accepted it in a later direct request. No extension-side tool execution. This does **not** prove the built-in Chat/Agent caller preserves that history. |
| 2026-10-10 | SaaS draft PR [#1436](https://github.com/lunaroute/lunaroute-saas/pull/1436), commit `756858b09644e51b6581be4a8d21e6b9e00e5799` | Scoped auth/onboarding checks | Local Go/frontend gates and PR CI passed. **Not merged or deployed**; deployed-SHA evidence unavailable. |

Final local extension gates were repeated with the planned Node 24 toolchain, extracted under ignored \`.vscode-test/node24/\` after verifying the official SHA-256 manifest; earlier Node 22 runs were preliminary. The inspected VSIX SHA-256 was \`88beedbd0d7a6432c9c994cee3d805f91a0dd7c7c59fd6e852e358a6210b9d11\` (ZIP timestamps mean a new package run can change that archive hash).

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

## Release automation and installation follow-up — 2026-10-11

The approved release path is a matching version tag, the reusable full CI workflow, then a **draft** GitHub Release with the tested VSIX. It does not publish to Marketplace, deploy SaaS, create tags implicitly or change repository visibility.

Nine CLI tag-validation cases were exercised (seven negative cases observed RED, then all nine GREEN). Local Node 24 verification now passes **208/208 tests**, typecheck/build/package, positive and negative archive checks, and installed-VSIX Linux host checks. Both workflows pass actionlint 1.7.7; that tool was downloaded and checksum-verified under ignored `.vscode-test/`, not installed system-wide. Logs: `release-*.log` in the plan workspace. No real release tag or draft-release API call was made, so draft creation itself is not end-to-end certified.

The existing bootstrap CI [run 38109493288](https://github.com/lunaroute/lunaroute-vscode-extension/actions/runs/38109493288) passed all three OS jobs at `ed3a35e`. Windows/macOS checks are unit/type/build evidence, not native desktop host certification.

Official installation research is linked in README: VSIX installs default to manual updates; private repository downloads require repository access; draft releases require push access; Marketplace publication is separate from GitHub repository ownership. The new repository resolves the repository-bootstrap gate, not Marketplace ownership or live compatibility.

## Remote SSH placement — 2026-11-06

Chat resolves models in the extension host that serves the workspace. In a remote window that is the remote host, so `extensionKind` now prefers `workspace` and the extension must be installed in the SSH/WSL/container host. A copy that runs locally in a remote window registers no provider and no MCP server, and warns once with `userMessage(new LunaRouteError('placement'))`.

| Environment / build | Expected | Actual / evidence |
| --- | --- | --- |
| VS Code **1.145.2** desktop client (macOS arm64), Remote-SSH host `legacy` (macOS arm64, `extensionKind: ["workspace","ui"]`, VSIX installed in the remote host, probe instrumentation) | Provider registers in the remote extension host and inference streams there | `remoteexthost` log: `placement uiKind=1 remoteName=ssh-remote extensionKind=2 vscode=1.145.2 kind=desktop`; `secrets.has=true`; `selectChatModels({"vendor":"lunaroute"}) -> 10`; `selectChatModels({}) -> 13` (`copilotcli/auto`, 10 LunaRoute, `copilot/gpt-4o-mini`, `copilot/auto`); `self-test: streamed "probe-ok"`. The local host did not also register in that session. |
| Same window, owner-driven UI check | A Local-harness chat request answered | Owner sent a chat message in the SSH window and received an answer. Session target was **Local**. |
| Remote sign-in callback forwarding | Unit-verified only | `tests/auth.test.ts` covers the forwarded authority (`port` param + accepted `Host`), a foreign `Host` rejection, a non-loopback (tunnel) forwarded authority failing as `callback`, and a forwarding failure surfacing as `network` without leaking its message. No live browser round trip from inside a remote window has been run. |

Copy that carried over: the remote host read the connection saved by a local sign-in (`secrets.has=true` before any remote sign-in), consistent with the documented client-side SecretStorage storage. A fresh machine, or a remote host with no prior local sign-in, still needs the remote sign-in path above.

Probe instrumentation (`[lunaroute-probe]` logging, a `~/.lunaroute-probe` self-test marker, and a `remote.extensionKind` override used to force the remote copy) was removed after the run; it is never part of a shipped build.

### Shipped build, no override — 2026-11-06 14:39 (local time)

The packaged VSIX (v0.1.2, `extensionKind: ["workspace","ui"]`) was installed in both hosts, then the SSH window was reloaded with no `remote.extensionKind` override:

- The **remote** host ran the extension (`ExtensionService#_doActivateExtension lunaroute.lunaroute` at 14:39:37, host `exthost9`), and that host emitted **no** `LanguageModelProxy` warnings — the failure mode this change removes.
- The **local** host did not activate the extension in that window (its last activation in that window's log is 10:34), so exactly one provider registered and the workspace preference in the manifest did its job.
- The owner sent a chat message in that window and received an answer.

Two background requests in the same window (14:40:00, the configured utility models) ended with the **designed** fail-closed error `item:message@response.output_item.added`: the gateway streamed a `message` item whose `role`/`phase` cannot be represented as native chat output (rule in src/responses.ts, covered by tests/responses.test.ts). Not a regression from placement, and not yet diagnosed further — a raw SSE capture from one of those requests is the next step.

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
| Remote SSH, workspace extension host | Passed, 1.145.2 (placement, resolution, stream) | Probe VSIX, 1.145.2 | Chat answered; remote sign-in pending a live check |
| Remote SSH, local-only install | Unit-checked: no provider/MCP registration, one placement warning | Pending | Pending |
| WSL, workspace extension host | Pending | Pending | Pending |
| Dev Container, workspace extension host | Pending | Pending | Pending |

Browser-only VS Code is unsupported. Marketplace publisher ownership, publication authority, cross-platform/remote checks beyond the row above, packaged live-login/inference and live native compatibility remain release gates. Unit placement checks are not a remote smoke test; the Remote SSH row is host evidence, the local-only row is not.
