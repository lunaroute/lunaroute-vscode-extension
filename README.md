# LunaRoute for VS Code

**Your LunaRoute models, inside native VS Code Chat and Agent — with a browser sign-in instead of an API key to copy around.**

Pick a LunaRoute model in the same model picker you already use, work in Chat or Agent mode, and let VS Code keep owning tools, approvals and workspace access. One sign-in connects the organization your plan belongs to.

> **Preview.** This extension is in active preview. Verified today: sign-in and native Chat on desktop VS Code 1.141 (Linux), model discovery, streaming, tool calls, and LunaRoute's hosted tools through MCP. Remote SSH windows are verified on VS Code 1.145.2 with LunaRoute installed in the remote host and a **Local** harness session. Still being validated: Windows and macOS extension hosts, WSL and Dev Containers, signing in from inside a remote window, long Agent sessions with tool history, and Marketplace install paths. Details and current evidence live in the repository's smoke checklist.

## What you get

| | |
|---|---|
| **Native, not a side panel** | LunaRoute models appear in VS Code's own Chat model picker. No separate chat UI to learn, no third-party extension reconfiguration. |
| **Agent mode with real tools** | Tool calls, approvals and execution stay with VS Code. Switch models or modes without changing how you work. |
| **Hosted LunaRoute tools** | Web, image and document tools from LunaRoute's hosted MCP server are offered to Agent mode — enable or disable them in **MCP SERVERS - INSTALLED** (or `MCP: List Servers`). |
| **Sign in, don't paste keys** | Browser authorization writes the credential straight into VS Code's SecretStorage. Nothing lands in a file, and Sign Out removes it locally. |
| **Your plan, your policies** | Models and tools follow your organization's entitlement and policy — including per-plan model allowlists and per-tool MCP switches. |
| **Reasoning models behave** | Reasoning is preserved for follow-up turns as opaque replay data and never shown as if it were the answer. |
| **Honest failure modes** | No silent model switching, no automatic retry loops, no workspace-configurable endpoints. If something can't be represented, you get told. |

## Quick start

1. **Install** this extension in desktop VS Code **1.141 or later**.
2. Run **`LunaRoute: Sign In`** from the Command Palette, then approve the request in the browser. Wait for the *“Connected to LunaRoute”* notification — that, not the browser redirect, means the credential is saved.
3. Open **Chat**, choose a **LunaRoute** model, and start typing. Switch to **Agent** mode when you want tools.

Commands you'll actually use:

- **LunaRoute: Sign In** — connect an organization (repeat to switch).
- **LunaRoute: Manage** — see the connection, refresh models, open the dashboard, sign out.
- **LunaRoute: Refresh Models** — reload the model list from the gateway.
- **LunaRoute: Sign Out** — remove the local credential. The key stays active server-side until you revoke it in the dashboard.
- **LunaRoute: Capture Chat Diagnostics (Preview)** — one-shot, local capture of a single request/response pair when support asks for it.

## Requirements

- **Desktop VS Code 1.141+**, installed wherever that window runs its chat: locally for a local window, and **in the remote host** for a Remote SSH / WSL / Dev Container window (see below). Browser-only VS Code (`vscode.dev`) is not supported.
- A **browser on the same computer** as VS Code — sign-in briefly listens on `127.0.0.1` for the callback.
- A **LunaRoute account** with the organization that should pay for the usage.
- Network access to `app.lunaroute.com`, `api.lunaroute.com`, `gw.lunaroute.com` and `mcp.lunaroute.com` from the host that runs the extension.

## Remote windows (SSH, WSL, Dev Containers)

Chat resolves models in the extension host that serves the workspace. In a remote window that host is on the remote machine, so LunaRoute has to be installed there:

1. Connect to the host, then install LunaRoute **in the remote host** — **Install in SSH: &lt;host&gt;** from the Extensions view, or **Install from VSIX...** while that window is connected.
2. In Chat, set **Session Target** to **Local**. The Copilot harness runs in the Agent Host, which cannot load extension-provided model providers yet ([microsoft/vscode#332085](https://github.com/microsoft/vscode/issues/332085)).
3. Sign in once. VS Code keeps the credential on the client, so windows on this machine share it — including a remote host you already signed in from locally.

If LunaRoute is installed only locally, it says so in the remote window instead of listing models that window cannot resolve.

## Credentials, privacy and limits

- The dedicated `lunaroute-vscode` key lives **only** in VS Code SecretStorage. There is no plaintext fallback, no workspace-configurable endpoint, and this extension never writes the key to disk.
- Requests resend the full history with `store: false`. The extension keeps **no conversation store** and never logs credentials, callback URLs, prompts or conversation content.
- Sign Out removes the local connection only — revoke unused keys in the [LunaRoute dashboard](https://app.lunaroute.com/dashboard), including any key left behind by a cancelled or failed sign-in.
- Token counts shown to the model picker are approximate (bytes plus framing and image budgets), not billing counts. Images count as **16,384 tokens** each.
- Optional diagnostics capture writes raw request/response files **only** to a folder you choose, and never includes request headers (so never your key).

## Troubleshooting

| Symptom | Do this |
|---|---|
| Sign-in never returns | Use the approval page's manual **Return to VS Code** link. Approval codes expire after **60 seconds** — start a new sign-in if it lapsed. |
| “unknown device-auth client” or a gateway error during sign-in | Update to the current preview build; older builds predate server-side support. |
| 401 / revoked key | Run **Sign In** again. The model list is invalidated, credentials are not silently deleted. |
| 403 / policy | Check organization and model permissions, and any desktop AI policy in your organization. |
| 402 / billing | Open **Manage → dashboard** and finish the connected organization's plan setup. |
| 429 / rate limited | Wait for the stated retry interval, then retry explicitly — nothing retries for you. |
| No models listed | **LunaRoute: Refresh Models**; check connectivity to `gw.lunaroute.com`. |
| No LunaRoute models in a Remote SSH / WSL / Dev Container window | Install LunaRoute **in the remote host** (Extensions → **Install in SSH: &lt;host&gt;**), then reload the window. A local-only copy explains itself instead of listing models. |
| Selected a LunaRoute model in a remote window and it reports the model is not available | That session uses the Copilot harness; switch **Session Target** to **Local**. |
| Remote sign-in reports it could not reach the callback | The forwarded loopback callback did not arrive as `127.0.0.1`. Sign in from a local window instead — the credential is shared — or retry the remote sign-in. |
| “unsupported or oversized input” | Reduce the input or start a new chat — unsupported history fails explicitly rather than disappearing. |
| MCP tools missing | **`MCP: List Servers`** → enable **LunaRoute**. If it reports unavailable, check its output before editing `mcp.json` by hand. |
| Something else | Run **LunaRoute: Capture Chat Diagnostics (Preview)**, reproduce once, and send the captured files to LunaRoute support. |

## Chat without GitHub sign-in

LunaRoute authentication and model access don't require a GitHub session. VS Code may still want utility models for background chat work — pick LunaRoute models in **Settings** (`chat.utilityModel`, `chat.utilitySmallModel`), or set `chat.byokUtilityModelDefault` to `mainAgent`. Those are VS Code settings; this extension never changes your preferences, and background requests can consume your allowance.

## About LunaRoute

Fixed-price inference for supported open models — so another attempt doesn't cost another token. Learn more at **[www.lunaroute.com](https://www.lunaroute.com)** and in the **[docs](https://docs.lunaroute.com)**.

## License

MIT — Copyright (c) 2026 LunaRoute, Inc. License and bundled third-party notices ship with the extension (`LICENSE`, `THIRD_PARTY_NOTICES.txt`).
