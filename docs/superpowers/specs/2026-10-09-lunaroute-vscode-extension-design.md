# LunaRoute for VS Code — v1 design

- Date: 2026-10-09
- Kata: `b7rz` — Design native LunaRoute VS Code Chat and Agent extension
- Status: Written spec approved by the user on 2026-10-09; implementation plan pending review.

## Goal and agreed scope

Install LunaRoute, sign in or create an account in the browser, approve access,
and use LunaRoute models in **native VS Code Chat and Agent mode**. Users must
not copy API keys or hand-edit provider configuration.

V1 supports desktop VS Code on Windows, macOS, and Linux, with local workspaces,
Remote SSH, WSL, and Dev Containers. Use stable, public VS Code APIs. Publish an
`engines.vscode` minimum matching a released version actually verified by the
extension-host and VSIX smoke tests; do not infer compatibility from types alone.

Explicit non-goals:

- Inline autocomplete, a separate chat panel, or a settings dashboard.
- Configuring Cline, Roo Code, Continue, or other chat extensions.
- Browser-only VS Code, including browser-based Codespaces.
- Automatic registration of LunaRoute web-search, image-generation, or document
  MCP tools. Normal Agent tool calling and users' existing MCP tools remain in scope.
- Simultaneous LunaRoute organizations/accounts, automatic key revocation, custom
  endpoints, conversation storage, or new extension analytics.
- A cross-repository shared SDK or refactoring the Pi/OpenCode extensions.

## Architecture

Ship one TypeScript extension with a Node entry point and
`extensionKind: ["ui"]`. It runs on the desktop even when the workspace is
remote. Browser authorization, credential access, catalog discovery, and
inference requests all run there. The desktop therefore needs network access
to LunaRoute; remote-host connectivity alone is not sufficient.

VS Code supplies the chat interface, conversation context, remote workspace
access, tool execution, and approval prompts. The extension is a model provider,
not an agent runner. It must not execute requested tools itself or bypass VS
Code's trust and approval controls. No remote companion process is required.

Register vendor `lunaroute` through `contributes.languageModelChatProviders` and
`vscode.lm.registerLanguageModelChatProvider`. Its management command opens a
small native menu. Use these boundaries, without adding a framework:

| Module | Responsibility |
| --- | --- |
| `src/extension.ts` | Activation, provider/command registration, management menu, disposal. |
| `src/auth.ts` | Browser authorization, callback validation, key exchange, SecretStorage, connection changes. |
| `src/catalog.ts` | Authenticated discovery, validation, capability mapping, in-memory catalog. |
| `src/provider.ts` | VS Code provider methods, model-change events, token estimates, cancellation. |
| `src/responses.ts` | VS Code/Responses message conversion and streamed response conversion. |

Use the OpenAI JavaScript SDK for Responses transport and stream decoding, with
its automatic inference retries disabled. Keep the VS Code-specific conversion
small and separately testable. Reuse the existing extensions' protocol contracts
and pure mapping ideas, not their host-specific credential/configuration code.

## User interface and connection lifecycle

Expose **LunaRoute: Sign In**, **LunaRoute: Sign Out**, **LunaRoute: Refresh Models**,
and the provider-management command. Management shows connection status, the
connected organization/account when available, these actions, and an action to
open the LunaRoute dashboard. No key display is needed.

A single connection is active in the extension's credential store. Signing in
again can select another organization. Windows sharing that store must react to
credential changes: discard the previous catalog, cancel obsolete work, and
refresh for the new connection. Late results from an old connection must not
repopulate the model list or replace current credentials.

Background activation and silent model discovery never open a browser or prompt
for credentials. Only choosing Sign In, directly or from management, starts
browser authorization. After sign-in, models become available through the native picker; do not replace
an existing model preference or silently change utility-model settings. For
account-free BYOK, document VS Code's native utility-model configuration if its
background features need a model selection.

Signing out clears the stored connection and in-memory catalog and cancels
pending authorization and inference. It does not revoke the server-side API key
or erase VS Code's own chat history. The management UI and README explain how to
revoke the key in LunaRoute's dashboard. Account replacement likewise does not
silently revoke a previous key.

## Browser authorization and new-account onboarding

Use the existing LunaRoute device-authorization protocol, with a new `vscode`
client, rather than introducing another OAuth server or device-polling protocol.

1. Start a temporary listener on `127.0.0.1` with an OS-assigned port. Generate
   independent random state and a PKCE verifier using Node crypto. Preserve
   LunaRoute's existing SHA-256 **hex** challenge format.
2. Open `https://app.lunaroute.com/device-auth/vscode` with only the port, state,
   and challenge. No API key or verifier enters a browser URL.
3. The browser handles sign-in/sign-up, email verification where required,
   organization setup/selection, and any required plan setup. Preserve a
   validated same-origin return path through those steps.
4. Once setup is complete, the user explicitly approves the VS Code client. The
   existing backend verifies membership and billing eligibility, then issues a
   short-lived, single-use code. Do not mint the code before a lengthy billing
   or onboarding detour.
5. The browser delivers the callback to the desktop listener. Validate the
   method, path, bounded code/state parameters, and expected state before
   accepting it. An invalid request must not consume the pending valid login.
   Duplicate callbacks must not cause multiple exchanges. Return the CORS
   headers needed by the trusted approval origin and a static, secret-free
   response; user-initiated callback navigation must also work. Callback delivery
   alone must not be presented by the extension as completed sign-in.
6. Exchange the code and verifier at `https://api.lunaroute.com/v1/auth/exchange`.
   The backend, not the extension, determines `source=vscode` and the key's
   organization. Use the existing label convention, `lunaroute-vscode <host>`.
7. Validate the response and save the connection in `ExtensionContext.secrets`.
   Report signed-in success only after that write succeeds. Then discover models.
   A catalog failure is a separate, recoverable state, not failed authentication.

Allow up to 15 minutes for the overall browser interaction, with visible Cancel.
The existing non-CLI authorization code lifetime is 60 seconds **after approval**;
there is no need to extend that lifetime for signup. Bound the exchange request
to 15 seconds. On cancellation, timeout, superseding sign-in, or deactivation,
close the listener, abort pending requests, and discard the in-memory verifier.
Late callbacks must never resurrect a cancelled login.

Automatic browser-to-loopback delivery can be blocked by browser policy. Retain
the existing approval page's user-initiated callback link as recovery. If that
also fails, explain the failure and allow a fresh sign-in; do not require users
to copy API keys or expose the listener on a public interface.

### SaaS changes

The existing flow is reusable but is not sufficient evidence of complete signup
onboarding. The current approval component surfaces missing-organization or
subscription errors; v1 must provide a recoverable route through setup and back
to the same pending authorization.

Required changes are confined to:

- `services/lunaroute-api/internal/handlers/cli_auth.go`: add `vscode` to the
  registered clients and label prefixes, retaining server-derived provenance,
  membership checks, billing checks, PKCE verification, and single-use codes.
- `services/lunaroute-front/app/device-auth/[deviceName]/page.tsx`: VS Code
  approval copy.
- The shared `DeviceAuthPage` and existing sign-in/sign-up/onboarding/billing
  return-path helpers, only where necessary to complete the described flow.
- Their existing authorization, callback-safety, and UI regression tests.

Do not introduce a client-supplied source override, bypass paid-plan eligibility,
or weaken redirect validation to make the flow work. Existing CLI, Pi, and
OpenCode behavior must remain supported. No Terraform changes are required.

## Credential and endpoint security

SecretStorage is the only persistent store for the key. Do not write it to
workspace settings, `globalState`, environment files, logs, or remote hosts. If
SecretStorage fails, fail visibly; never implement a plaintext fallback. Do not
claim successful sign-in or sign-out when the corresponding store/delete fails.
If a key was minted but could not be saved, explain that it can be revoked in the
dashboard rather than claiming that sign-in succeeded.

Production uses the existing canonical HTTPS origins:

- Account/approval UI: `https://app.lunaroute.com`.
- Code exchange: `https://api.lunaroute.com`.
- Model discovery/inference: `https://gw.lunaroute.com/v1`.

No workspace-controlled endpoint setting may redirect credential-bearing
requests. Returned optional endpoint fields are not authority to send the key
to arbitrary hosts. Test endpoints are injected by tests, not exposed as a
workspace setting. Extension-issued exchange, catalog, and inference requests
must reject redirects rather than automatically resending credentials or
exchange bodies elsewhere. This does not disable the browser's normal SSO flow.

Never log API keys, verifiers, authorization codes, full callback URLs, prompts,
tool contents, or conversation content. Diagnostics may include sanitized error
categories, status codes, and request IDs. Preserve existing LunaRoute request
attribution: `lunaroute-agent: vscode/<extension-version>`, with the same random
session ID in `x-lunaroute-session` and `lunaroute-session-id`. Generate that ID
per extension-host activation; do not claim it identifies an individual chat
when the provider API does not expose that identity.

## Catalog and model selection

Fetch authenticated `GET /v1/models` after sign-in, on provider activation with a
stored credential, and on explicit refresh. Use a 10-second timeout and coalesce
concurrent refreshes for the same connection. A successful refresh replaces the
catalog and fires the provider's model-information change event.

- Publish stable model IDs and display names from the catalog.
- Require valid positive context/output limits and a usable input budget; do not
  invent large defaults for malformed entries. Reserve the advertised output
  capacity when deriving the maximum input budget.
- Advertise vision and tool calling only when confirmed by catalog capabilities
  and supported by the adapter. Models without tool support are Chat-only.
- Exclude non-chat families: image generation, embeddings, reranking,
  transcription, and System One classifiers.
- Skip malformed entries with a sanitized diagnostic; reject a malformed catalog
  envelope rather than treating it as a successful empty response.

Keep the last successful catalog only in memory and only for the same connection.
A transient refresh failure can retain that metadata with a visible refresh
error. Sign-out, credential changes, or confirmed authorization denial invalidate
it. An empty authorized catalog is a legitimate state with an explanation, not
a fake selectable "login model". Provider management remains accessible.

Do not introduce persistent offline discovery or model-name allowlists. New
compatible chat models should appear after refresh without an extension update.
If a catalog model requires message semantics the stable adapter cannot support,
exclude it explicitly with a diagnostic rather than advertise broken support.

## Chat and Agent request contract

Use `POST /v1/responses` as the sole v1 inference dialect, matching both existing
extensions' current defaults. Managed LunaRoute Responses routes are stateless:
send the complete conversation supplied by VS Code on every request, set
`store: false`, and never rely on `previous_response_id`. This does not make a
claim about gateway logging or upstream retention policies.

The adapter must:

- Preserve instruction roles, text, supported image data, tool definitions,
  tool-call identifiers, arguments, and corresponding tool results in order.
- Honor VS Code's tool-selection mode, including required tool use.
- Stream text as received. Assemble fragmented tool-call arguments and emit
  complete, structurally valid tool calls without executing them.
- Support multiple tool calls in a response and subsequent multi-step turns.
- Preserve model-required replay metadata when representable through stable
  VS Code APIs. Never flatten reasoning/opaque data into user text or silently
  discard required history. Reasoning-model compatibility is a release test.
- Reject unsupported non-empty content parts clearly rather than dropping them.
- Treat malformed streams, incomplete tool calls, upstream error events, and
  unexpected termination as failures, not successful empty responses.
- Abort network work when VS Code cancels the request, sign-out occurs, or the
  connection is replaced. Cancellation is best-effort upstream and does not
  promise reversal of already incurred usage.

Implement `provideTokenCount`; do not leave the provider API incomplete. V1 counts
are conservative estimates, not exact tokenization for every model family.
Account for non-ASCII text, tool arguments/results, message overhead, and image
inputs rather than using a text-only character count. Reserve output capacity
and surface gateway context-limit errors without silently truncating content.
Calibrate the estimate in representative near-limit text/vision smoke tests;
document its limitations rather than claiming guaranteed budget accuracy.

VS Code decides which tools are available and executes approved calls in the
correct workspace. The extension must not add its own shell/file execution loop
or register LunaRoute's additional MCP tools in this release.

## Errors and recovery

| Condition | Behavior |
| --- | --- |
| Signed out / invalid credential | Explain that Sign In is required; no automatic browser launch. |
| Organization or policy denial | Explain the restriction; do not repeatedly remint credentials or bypass it. |
| Billing/subscription requirement | Offer the LunaRoute dashboard/setup route with safe return handling during login. |
| Authorized catalog is empty | Keep management accessible and explain that no compatible chat models are available. |
| Rate limit | Show a recoverable rate-limit message and retry timing when provided. |
| Network/upstream failure | Report a sanitized failure and allow explicit retry. |
| Secure storage failure | Do not report successful sign-in or persist the key elsewhere. |
| Unsupported input / context limit | Explain the unsupported content or size; do not silently discard input. |

No silent fallback to another model or provider. No automatic inference retries,
including SDK defaults: ambiguous failures can incur duplicate usage, and replay
can duplicate Agent activity. Auth exchange is also not automatically replayed.
A transient failure must not delete a previously valid stored credential.
Respect VS Code's organization BYOK policy and user-disabled AI features.

## Verification and release gates

Implementation needs tests of behavior and contracts, not assertions about source
text. The following are release requirements, not claims that testing has run.

### Automated extension checks

- Type checking, focused tests, build, and VSIX packaging in CI.
- Login state mismatch, malformed/duplicate callbacks, expired codes, cancellation,
  timeouts, superseded attempts, storage failure, and sign-out/key-change races.
- Catalog capability/limit validation, non-chat filtering, empty/malformed
  catalogs, refresh failure, and obsolete results after connection changes.
- Message conversion with instructions, images, multiple tool calls/results, and
  required tool mode; no silent content loss.
- Responses transport against a controlled HTTP/SSE server, exercising the real
  SDK path: fragmented events, terminal errors, truncated streams, cancellation,
  full-history replay, `store: false`, and absence of automatic retries.
- Token estimates for non-ASCII text, tools, and image input; error sanitization
  and rejection of credential-bearing redirects.
- An extension-host integration test for provider registration, commands, model
  refresh events, and SecretStorage lifecycle.

### SaaS regression checks

Test the new client and minted key provenance; preserve unknown-client rejection,
organization membership and billing enforcement, PKCE mismatch handling, and
single-use codes. Test return-path preservation through signup, verification,
organization setup, and billing, including rejection of unsafe redirects.
Existing CLI/Pi/OpenCode authorization tests must continue to pass.

### Real VS Code smoke checks

Use a test LunaRoute organization and record the VS Code version and environment.
Before release, verify:

1. Packaged extension installation and local sign-in on Windows, macOS, and Linux.
2. Existing-user login and fresh-account signup/setup through first model use.
3. A fresh VS Code profile without GitHub/Copilot sign-in: Chat and Agent work
   with LunaRoute, subject to VS Code policy and available features.
4. Streaming Chat; a multi-step Agent task that reads/edits a file and runs a
   command with normal VS Code approvals; vision and reasoning-model turns.
5. Near-context-limit inputs, cancellation, revoked keys, billing/rate errors,
   restart, sign-out, and credential changes in multiple windows.
6. Remote SSH, WSL, and Dev Container workspaces, confirming that the provider
   runs locally and the remote workspace needs no LunaRoute key or companion.
7. Browser loopback recovery when automatic delivery is blocked.

Test one packaged VSIX before Marketplace publication. Pin the tested minimum
stable VS Code version, document support and limitations, and keep the release
unpublished until the owner authorizes publication with the required publisher
access. Do not claim environments were verified if they were unavailable.

## Evidence and remaining validation

Source inspection supports the reuse decisions; no extension implementation or
live onboarding/Agent tests exist yet. The principal release risks are:

- Signup/billing may require additional return-path fixes in the SaaS frontend.
- Browser loopback policies and platform SecretStorage behavior need real tests.
- Stable VS Code model-provider APIs must faithfully carry tool, vision, and
  reasoning history on the chosen minimum release, including remote workspaces.
- Token estimates are approximate across model families.
- Local sign-out and failed/replaced login can leave server keys active until
  the user revokes them in the dashboard.

Inspected source references:

- `lunaroute-pi-extension/src/login.ts`, `src/lunaroute.ts`, `src/discovery.ts`.
- `lunaroute-opencode-extension/src/login.ts`, `src/lunaroute.ts`, `src/models.ts`.
- `lunaroute-saas/services/lunaroute-api/internal/handlers/cli_auth.go`.
- `lunaroute-saas/services/lunaroute-front/components/DeviceAuthPage.tsx`,
  `auth.config.ts`, and the device-auth page/authorize routes.
- `lunaroute-saas/services/lunaroute-docs/src/content/docs/api/responses.md`.
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider).
- [Extension host placement](https://code.visualstudio.com/api/advanced-topics/extension-host)
  and [remote extension guidance](https://code.visualstudio.com/api/advanced-topics/remote-extensions).
- [Current BYOK behavior and limitations](https://code.visualstudio.com/blogs/2026/06/18/byok-vscode).

## Approval boundary

This document records the agreed design and makes its engineering constraints
explicit. The user approved the written spec at commit `14e6210` on 2026-10-09.
That approval authorizes implementation planning, not product implementation or
publication. Obtain review of the implementation plan and an execution-method
choice before starting product code.
