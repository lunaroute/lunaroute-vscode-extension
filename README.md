# LunaRoute for VS Code

<img src="icon.png" alt="LunaRoute" width="128">

LunaRoute models in native VS Code Chat and Agent mode, with browser sign-in instead of copying API keys.

[Source](https://github.com/lunaroute/lunaroute-vscode-extension) · [Build and test](https://github.com/lunaroute/lunaroute-vscode-extension/actions/workflows/check.yml)

**Preview, not Marketplace-published or release-certified.** The scoped SaaS sign-in change still needs authorized deployment. Linux VS Code 1.141.0 direct extension-host contracts pass; live native Chat/Agent, other desktop OSes and remote workspaces remain release gates. See the source evidence document `docs/smoke-checklist.md`.

## Get the preview package

The preview is distributed as a **VSIX**, not through Marketplace. Use a published GitHub release if available, otherwise use a CI artifact or a maintainer-provided file. The repository is currently private.

- **Repository members:** sign in to GitHub, open a successful [Check and package run](https://github.com/lunaroute/lunaroute-vscode-extension/actions/workflows/check.yml), and download the `lunaroute-vsix` artifact. Extract the downloaded artifact ZIP to get `lunaroute.vsix`; do not extract the VSIX itself. Artifacts expire according to GitHub retention settings.
- **Invited testers without repository access:** a maintainer can provide the tested `lunaroute.vsix` file through an approved download channel. The private repository/Actions links will not work for them.
- **After a release is published:** download `lunaroute.vsix` from its [release assets](https://github.com/lunaroute/lunaroute-vscode-extension/releases), not GitHub's source-code ZIP. Publishing a release in a private repository still requires repository read access to download it. Draft releases are maintainer-only, not a tester download channel.
- **Build it yourself:** with repository access, clone the repo and run `npm ci && npm run package` using Node 24.

Installing this preview is possible before release certification; working live sign-in still depends on the scoped SaaS deployment, and native Chat/Agent still needs the live checks described above.

## Install and connect

1. Use desktop VS Code **1.141.0 or later**. Only 1.141.0 on Linux has direct host evidence so far; later releases and other platforms need verification.
2. Open the Extensions view, select its **…** menu → **Install from VSIX…**, and choose `lunaroute.vsix`. Alternatively, run the following in a terminal on the **local desktop**, not inside SSH/WSL/a container:

   ```sh
   code --install-extension ./lunaroute.vsix
   ```

   On macOS, if `code` is not on PATH, use VS Code's **Shell Command: Install 'code' command in PATH** or use the UI installation method. Only install packages from a trusted LunaRoute source; respect publisher-trust prompts and organizational extension policies.
3. Run **LunaRoute: Sign In**. In the browser, sign in or create a LunaRoute account, verify your email if needed, choose your organization and finish any required plan setup.
4. Return to the pending authorization page and approve the extension. Wait for VS Code's **Connected to LunaRoute** notification; receiving a browser callback alone does not mean credentials were saved.
5. Choose a LunaRoute model in VS Code's native Chat model picker. Select Agent mode for tool-capable models. VS Code owns tool execution, workspace access and approvals.

One organization is connected at a time. **LunaRoute: Manage** offers connection changes, refresh and the dashboard. **LunaRoute: Refresh Models** explicitly reloads the authenticated catalog. Existing model preferences are never changed by this extension.

### Updates

VS Code disables automatic updates by default for extensions installed from a VSIX. To update this preview, download the newer VSIX and install it the same way; reload VS Code if prompted. This extension does not install its own updater or change update preferences. Normal Marketplace distribution is the intended route to discoverable installs and automatic updates, subject to users' settings and organization policy.

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

## Preview diagnostics

Run **LunaRoute: Capture Chat Diagnostics (Preview)**, pick a folder, then send one chat message. The extension writes that exchange there:

- `<stamp>-request.json` - the exact stateless request sent to LunaRoute
- `<stamp>-response.meta.json` - endpoint, status and response headers
- `<stamp>-response.sse` - the raw event stream returned by the gateway
- `<stamp>-error.txt` - safe failure metadata (kind, status, protocol detail) when the exchange fails

Capture is opt-in and one-shot: it is not telemetry, nothing is uploaded, and the API key is never written (credentials stay in request headers, which are not captured). The files do contain your prompts, tool history and the model's response - review them before sharing.

## MCP tools (native Agent mode)

While you are signed in, the extension contributes LunaRoute's hosted MCP server (`https://mcp.lunaroute.com/mcp`) so native Agent mode can use those tools (web, image and document families) with no manual configuration.

- VS Code owns the server lifecycle: enable or disable it in **MCP SERVERS - INSTALLED** (Extensions view) or via **MCP: List Servers**, and it asks before running a tool. The extension never executes tools itself.
- Your organization's LunaRoute tool policies still apply server-side, so a tool disabled for your user or organization stays unavailable.
- The extension stores nothing for the server: it hands VS Code a definition carrying your current key in request headers, re-resolved whenever credentials change. Signing out stops offering the server, and the key is never written to disk by this extension.
- Header-authenticated MCP servers have known VS Code regressions; if the server reports unavailable, check **MCP: List Servers** output and report it rather than editing `mcp.json` by hand.

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

## Releases — maintainers

The [Draft VSIX release workflow](.github/workflows/release.yml) runs when a `v*` tag is pushed:

1. Require the tag to equal `v` plus `package.json`'s version.
2. Run the same Windows/macOS/Linux CI, including Linux source-host, archive/negative checks and installed-VSIX host tests.
3. Download that run's tested `lunaroute.vsix` artifact and attach it to a **draft** GitHub Release with generated notes. It does not rebuild the package after testing, publish the draft, deploy SaaS or publish to Marketplace.

Only the draft-creation job gets `contents: write`; other jobs are read-only. It uses GitHub's automatic `GITHUB_TOKEN`, not a new PAT or Marketplace secret. `--verify-tag` prevents implicit tag creation. Existing releases are not overwritten; inspect any partially created draft before repairing or rerunning a failed release.

For a new version, update `package.json` and `package-lock.json` together (`npm version <version> --no-git-tag-version`), then review and merge that commit. Once the approved release commit is on `main`, push its matching tag. For example, **only if that commit declares version 0.1.0**:

```sh
git fetch origin
git tag -a v0.1.0 origin/main -m "LunaRoute for VS Code v0.1.0"
git push origin v0.1.0
```

Inspect the draft's asset and notes. Publishing it is a separate, explicit maintainer action after the [release checklist](docs/smoke-checklist.md) and applicable approvals are satisfied. Do not move or reuse release tags.

## Distribution to ordinary users — Marketplace

**Recommended public installation path:** publish under a LunaRoute-owned Visual Studio Marketplace publisher, then users can search for LunaRoute in VS Code's Extensions view and click **Install**. Marketplace installation does not require access to this private source repository.

Before doing that:

1. Complete the SaaS deployment, live native Chat/Agent/onboarding checks, platform checks and calibration in the release checklist.
2. Create or confirm ownership of a publisher at [Marketplace publisher management](https://marketplace.visualstudio.com/manage). The GitHub organization does **not** establish Marketplace ownership. The provisional `publisher: lunaroute` plus `name: lunaroute` gives the intended extension ID `lunaroute.lunaroute`; settle that identity before general distribution.
3. Obtain publication approval and upload the tested VSIX through the publisher portal. Marketplace automation is deliberately absent from this repository. For future automated publishing, current VS Code guidance recommends Microsoft Entra ID-based authentication rather than long-lived global PATs.
4. Only **after** the listing exists, users can install through the Extensions view or `code --install-extension lunaroute.lunaroute`. That Marketplace command is **not available yet**.

A public GitHub release or another approved public VSIX download host is an alternative for manual installation. The current private repository is not such a public channel; changing its visibility requires a separate decision.

### Official installation and distribution references

- [VS Code: install from a VSIX and update behavior](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)
- [VS Code: packaging, publishers and Marketplace publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [GitHub: downloading workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
- [GitHub: release visibility and permissions](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub: draft releases require push access](https://docs.github.com/en/rest/releases/releases#list-releases)

## License

[MIT](LICENSE) — Copyright (c) 2026 LunaRoute, Inc. Bundled SDK notices are in `THIRD_PARTY_NOTICES.txt`.
