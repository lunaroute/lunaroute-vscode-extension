# LunaRoute for VS Code — remote-host placement and forwarded sign-in

**Status:** implemented and verified on VS Code 1.145.2 (Remote-SSH); written as the design record
for commit `34fe4b5`. Supersedes the placement decision in
[the v1 design](2026-10-09-lunaroute-vscode-extension-design.md#architecture).

## Intent

LunaRoute models should work in a Remote SSH window the same way they work in a local window: pick a
model in the native picker, send a message, get an answer. Before this change they could not.

The v1 design put the extension in the **UI** host (`extensionKind: ["ui"]`) on the theory that a
remote window only needs the desktop's browser and network. Chat does not work that way: it resolves
language models in the extension host that serves the workspace. In a remote window that host is on
the remote machine, so the UI-host provider was unreachable and every request failed.

## What the failure actually looked like

From a real Remote SSH window (VS Code 1.145.2, macOS client, macOS remote host) before the change:

- Remote extension host: `[LanguageModelProxy](GitHub.copilot-chat) Could not find model
  'lunaroute/deepseek-4.1-flash' in local cache after re-resolving models.`
- Renderer: `The selected model 'lunaroute/deepseek-4.1-flash' is not available. Select a different
  model and try again.`
- The picker still listed ten LunaRoute models, because the workbench aggregates providers from every
  host. The list was real; the resolution was not.

Both harnesses failed. The **Local** harness runs in the extension host, which had no provider. The
**Copilot** harness runs in the Agent Host, which per Microsoft's own documentation
(`/docs/agents/concepts/agent-host`) hosts no extension code at all: "Extensions can contribute
tools, MCP servers, and custom agents without running the agent harness itself." Microsoft tracks
that gap for BYOK and extension-provided models in
[microsoft/vscode#332085](https://github.com/microsoft/vscode/issues/332085), where the guidance is to
use the Local harness in remote windows.

Installing the extension in the remote host did not help either: `activate()` refused any placement
other than the UI host.

## Goals

- Chat streams in a Remote SSH / WSL / Dev Container window, from a provider running where that
  window's chat runs.
- The credential stays where it already was: VS Code's client-side SecretStorage. No second sign-in
  for a machine whose user is already signed in.
- Sign-in from inside a remote window completes through the browser, or fails with a message that
  says what to do instead of hanging.
- A configuration that cannot work says so, once, instead of advertising models the window cannot
  resolve.

## Non-goals

- Making the Copilot harness (Agent Host) see extension-provided models. Not possible from an
  extension; tracked upstream. Remote windows need **Session Target → Local**.
- A remote companion process, a server-side key store, or a workspace-configurable endpoint.
- WSL, Dev Containers, Windows and macOS extension-host certification. The mechanism is shared; the
  runs are not done.

## Anti-goals

- Two providers registering the same vendor in one window (duplicate or conflicting model entries).
- A picker entry that fails at send time. A model that cannot be used must not be offered.
- Treating a forwarded callback authority from a tunnel host as if the browser could dial it.
- Weakening the callback checks that the v1 design established (single `Host`, exact path, PKCE,
  timing-safe state comparison, single use, CORS origin allowlist).

## Approaches considered

**A. Keep UI placement and let the LanguageModelProxy bridge.** VS Code contains a proxy that lets one
host ask another for models. It exists, and it is what produced the "could not find model … in local
cache" warning. In practice it did not return our models after re-resolving, for either harness, and
nothing an extension can do changes that code path. Rejected: it is a bug to report upstream, not a
foundation to build on. It also leaves the request running against a provider in the wrong host for
every future change.

**B. Run the extension where chat runs — the workspace (remote) host.** Chosen. `extensionKind`
prefers `workspace`; the extension activates in the remote host, registers the provider and the MCP
server there, and inference goes out from the remote machine's network. VS Code's Remote Development
docs confirm the piece that makes this safe: SecretStorage "will always store the secrets on the
client side … regardless of where your extension is running", so the key does not land on the remote
filesystem.

**C. Register in both hosts and proxy inference from the remote host back to the local one.** This
would keep all network access on the desktop. There is no public API for a remote extension to call
into a local one; the only cross-host channel VS Code gives extensions is port forwarding, which
runs client-to-server. Rejected: no supported transport.

**D. Wait for the Agent Host BYOK bridge.** Upstream work exists for built-in "Custom Endpoint" BYOK
(`vscode.byokLmBridge`, PR microsoft/vscode#346352) but not for extension-provided providers. Rejected
as the plan: it does not make chat work today and it is not ours to schedule. It stays the reason the
Copilot harness is documented as unsupported for these models rather than quietly half-working.

## How it works

### Placement

- `package.json`: `extensionKind: ["workspace", "ui"]`. Workspace preference, so a remote window uses
  the copy installed in the remote host; a local window is unaffected because there the workspace
  host *is* the local host; and a machine with only a local install still runs the extension locally.
- `src/extension.ts`: activation refuses only `UIKind.Web`. A copy running in the **UI** host of a
  remote window (`env.remoteName` set, `extension.extensionKind` not Workspace) registers **no** chat
  provider and **no** MCP server, and warns once with the `placement` message. Commands stay
  registered: sign-in and sign-out are meaningful there, because the credential is shared with the
  remote host.
- `Refresh Models` and `Manage` surface `placement` in that state, so a support conversation does not
  have to guess why nothing is listed.

### Forwarded sign-in callback

Sign-in binds an ephemeral listener on `127.0.0.1` of whichever host runs the extension and opens
`app.lunaroute.com/device-auth/vscode` in the user's browser, which redirects back to that loopback
port. On the desktop that is direct. From a remote host the browser cannot reach the remote's
loopback, so:

- `src/auth.ts` resolves the callback authority through an injected `deps.forward`; `src/extension.ts`
  supplies `vscode.env.asExternalUri` **only** for a copy running in the remote host (a remote window with
  `extensionKind` Workspace). Locally, and for a local-only copy in a remote window, the listener is on the
  machine with the browser and the behavior is byte-identical to before.
- The forwarded **port** is what the device-auth page is told to redirect to, because that is the port
  the browser dials.
- The listener accepts exactly two `Host` values: the bound loopback authority and the forwarded
  authority. Anything else is still a 400.
- A forwarded authority that is not `127.0.0.1` / `localhost` (a tunnel host, where the browser cannot
  use a loopback callback at all) fails immediately as `callback`: "LunaRoute could not reach the
  sign-in callback through this remote connection. Try again, or sign in from a local window." The
  alternative — waiting out the 900-second login timeout — was the behavior worth avoiding.
- A forwarding failure surfaces as `network` without echoing its message.

### Failure vocabulary

Two kinds joined `FailureKind`, both with static messages: `callback` and `placement`. They exist
because "check your network" and "an unsupported response" are wrong answers to "this window cannot
host the extension" and "the callback cannot come back through this connection".

## Security properties

- The key remains in client-side SecretStorage. Nothing is written to the remote filesystem, and the
  extension still has no plaintext fallback.
- Callback validation is unchanged except for the `Host` allowlist, which is still exact-match and
  still a set of one locally. PKCE verifier, timing-safe state comparison, single use, exact path,
  `origin` allowlist, `no-store` and CSP headers all stay.
- The forwarded authority is accepted only in loopback form. A tunnel hostname is refused rather than
  trusted, because the front end redirects the browser to `127.0.0.1:{port}` and a tunnel authority
  cannot be reached that way.
- Inference runs on the remote machine, so the remote host now needs egress to `gw.lunaroute.com`.
  That is a real change in who needs network access and it is documented in the README.

## Verification

Unit (244 tests, `npm run check`, typecheck, build, VSIX allowlist and both canary checks):

- Placement: three remote names × {local-only stand-down, workspace registration}, workspace
  registration in a local window, browser-only refusal.
- Forwarding: forwarded port advertised, forwarded `Host` accepted, loopback `Host` still accepted when
  forwarding preserves the port, foreign `Host` rejected and a later valid callback still consumed,
  non-loopback authority → `callback`, forwarding failure → `network` without leaking its message.
- Manifest assertion in `tests/check-vsix.py` and `tests/host/index.ts`.

Live, VS Code 1.145.2, Remote-SSH host `legacy`, packaged VSIX installed in both hosts, **no**
`remote.extensionKind` override:

- A probe build (since removed) logged in the remote extension host: `remoteName=ssh-remote
  extensionKind=2`, `secrets.has=true`, `selectChatModels({vendor:'lunaroute'}) -> 10`, and
  `self-test: streamed "probe-ok"`.
- After the shipped build: the remote host activated the extension at 14:39:37, the local host did not
  activate it in that window, and that host produced **no** `LanguageModelProxy` warnings. An
  owner-driven chat request answered.

Not verified: signing in from inside a remote window (browser round trip through the forwarded port);
WSL; Dev Containers; Windows and macOS extension hosts.

## Open items

- Two background utility requests in the verified window ended with the pre-existing fail-closed rule
  `item:message@response.output_item.added` (a `message` item whose `role`/`phase` cannot be
  represented). Unrelated to placement; the next step is a raw SSE capture from one of those requests.
- Sign-in from inside a remote window needs a live round trip before the README stops hedging.
- WSL and Dev Containers share this mechanism and need their own runs before the matrix moves.
