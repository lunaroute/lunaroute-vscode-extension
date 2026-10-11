# LunaRoute for VS Code

LunaRoute models in native VS Code Chat and Agent mode, with browser sign-in instead of copying API keys.

[Source](https://github.com/lunaroute/lunaroute-vscode-extension) · [Build and test](https://github.com/lunaroute/lunaroute-vscode-extension/actions/workflows/check.yml)

**Preview, not published or release-certified.** The scoped SaaS sign-in change still needs authorized deployment. Linux VS Code 1.141.0 direct extension-host contracts pass; live native Chat/Agent, other desktop OSes and remote workspaces remain release gates. See the source evidence document `docs/smoke-checklist.md`.

## Install and connect

1. Use desktop VS Code **1.141.0 or later**. Only 1.141.0 on Linux has direct host evidence so far; later releases and other platforms need verification.
2. Open Extensions → **Install from VSIX…** and select the preview `lunaroute.vsix`.
3. Run **LunaRoute: Sign In**. In the browser, sign in or create a LunaRoute account, verify your email if needed, choose your organization and finish any required plan setup.
4. Return to the pending authorization page and approve the extension. Wait for VS Code's **Connected to LunaRoute** notification; receiving a browser callback alone does not mean credentials were saved.
5. Choose a LunaRoute model in VS Code's native Chat model picker. Select Agent mode for tool-capable models. VS Code owns tool execution, workspace access and approvals.

One organization is connected at a time. **LunaRoute: Manage** offers connection changes, refresh and the dashboard. **LunaRoute: Refresh Models** explicitly reloads the authenticated catalog. Existing model preferences are never changed by this extension.

### Remote SSH, WSL and Dev Containers

Install LunaRoute in the **local/UI** extension host, not on the remote workspace host. Browser authorization, SecretStorage and gateway traffic stay on the desktop. VS Code remains responsible for remote files and tools.

These placements are design targets with unit guards, not completed remote smoke tests. Browser-only VS Code (`vscode.dev`, Codespaces in a browser) is unsupported.

### Desktop network and browser requirements

The desktop needs HTTPS access to `app.lunaroute.com`, `api.lunaroute.com` and `gw.lunaroute.com`, plus a browser on the **same computer**. Sign-in briefly listens on an ephemeral `127.0.0.1` port. Browser/firewall/private-network policies must allow that callback.

If automatic return is blocked, use the authorization page's manual **Return to VS Code** link on that computer. Approval codes expire after 60 seconds. An expired/closed sign-in attempt needs a fresh **LunaRoute: Sign In**; there is no key-paste fallback. Preserve your organization's browser and VS Code security policies.

### Without GitHub/Copilot sign-in

LunaRoute authentication and direct model access do not require a GitHub session. VS Code may need utility models for background Chat operations. In native **Settings**, search for:

- `chat.utilityModel` and `chat.utilitySmallModel`: explicitly choose suitable available LunaRoute models.
- Alternatively, `chat.byokUtilityModelDefault` can use `mainAgent` instead of Copilot for unspecified utility models.

These are **VS Code** controls, not LunaRoute configuration. The extension never sets them. Background requests may consume your LunaRoute allowance. VS Code version, feature availability and organization policy still apply; a full fresh-profile native Agent workflow without GitHub has **not** yet been certified.

## Credentials, data and limits

- The dedicated `lunaroute-vscode` key lives only in VS Code **SecretStorage**. There is no plaintext fallback or remote credential file. Secure-storage failures need repair of the desktop's storage/keyring, not a workaround file. Cancellation waits for in-flight secure writes and cleanup to settle.
- **LunaRoute: Sign Out** removes the local saved connection and aborts its work. It **does not revoke the server-side key**. Revoke unused keys in the [LunaRoute dashboard](https://app.lunaroute.com/dashboard), including keys left by an approved but cancelled/failed sign-in.
- Messages, supported images and tool results supplied by VS Code are sent to LunaRoute. Requests resend full history with `store: false`; the extension does not keep a conversation store or log credentials, callback URLs or conversation contents. VS Code and service data policies remain separate.
- There are no workspace-configurable endpoints, automatic inference/exchange retries, or silent model/provider fallback.
- Token counts are approximate: UTF-8 bytes plus framing/tool data, serialized replay data and **16,384 per image**. These are not billing counts or a guarantee of model acceptance. Near-limit/model-specific calibration remains a release gate.
- PNG/JPEG/WebP/GIF image input requires a vision-capable model. UTF-8 text/JSON data is supported; other attachments or unrepresentable history fail explicitly, never disappear silently.
- Opaque reasoning replay belongs to the model that produced it. Start a **new chat** when changing models with such history, or when the host reports unsupported history. Native Chat/Agent retention still needs the live compatibility checkpoint.

## Recovery

| Problem | Action |
| --- | --- |
| 401 / revoked key | Run Sign In again. The model list is invalidated; credentials are not silently deleted. |
| 403 / policy or permission | Check organization/model permissions and desktop AI policy; the extension does not bypass them. |
| 402 / billing | Open Manage → dashboard and finish the connected organization's plan/billing setup. |
| 429 / rate limit | Wait for the displayed retry interval, if supplied, then retry explicitly. |
| Network / no models | Check desktop connectivity, then Refresh Models. Transient catalog failures can retain same-connection metadata; no login-placeholder model is created. |
| Storage / incomplete cleanup | Repair secure storage and retry Sign Out; a cancelled sign-in may still have a saved key. Revoke unused keys in the dashboard. |
| Unsupported / oversized history | Reduce input or start a new chat. Report native compatibility failures rather than dropping required history. |

## Scope

Chat + Agent only. No autocomplete, separate chat panel, automatic LunaRoute MCP registration, third-party extension configuration, background tool execution or automatic model preference changes.

## Development

Node **24** is the development/CI target; the extension bundle targets Node 22. Dependencies are pinned.

```sh
npm ci
npm run check
npm run build
npm run test:host                 # desktop display required
# Linux headless: xvfb-run -a npm run test:host
npm run package
python3 tests/check-vsix.py lunaroute.vsix
python3 tests/check-vsix-negative.py lunaroute.vsix
# Packaged install into a disposable profile:
# xvfb-run -a npm run test:host -- --vsix lunaroute.vsix
```

Host tests use a separate synthetic probe extension, loopback HTTP and a temporary profile; they do not access the user's LunaRoute connection. Packaging includes the runtime bundle and legal/documentation files only. CI checks/builds on Windows, macOS and Linux, runs host/package checks on Linux and uploads a VSIX artifact; it does **not** publish or deploy SaaS.

The provisional publisher `lunaroute` is not proof of Marketplace ownership. Publisher ownership, authorized SaaS deployment, native compatibility/calibration and the remaining platform matrix must be resolved before publication. Creating the GitHub repository does not publish the extension to the Marketplace.

## License

[MIT](LICENSE) — Copyright (c) 2026 LunaRoute, Inc. Bundled SDK notices are in `THIRD_PARTY_NOTICES.txt`.
