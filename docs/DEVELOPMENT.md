# Development and release notes

Maintainer-facing material for the LunaRoute VS Code extension. The packaged `README.md` is the
user-facing listing; everything below is repo-only (not shipped in the VSIX).

## Layout

- `src/` — extension source. `responses.ts` owns the request builder and the strict stream
  validator; `provider.ts` the native chat provider; `catalog.ts` model discovery; `auth.ts` the
  loopback + SecretStorage sign-in; `extension.ts` activation, commands and the MCP contribution.
- `tests/` — unit tests plus `tests/host/`, which runs real VS Code 1.141 against packaged and
  source builds, and `tests/check-vsix*.py`, the archive allowlist/credential checkers.
- `docs/smoke-checklist.md` — the verification ledger: what is proven, how, and what is still open.
- `docs/superpowers/` — approved spec and implementation plan for the original build.

## Build and verify

Node **24** is the development/CI target (the bundle targets Node 22); dependencies are pinned.

```sh
npm ci
npm run check          # typecheck + unit tests
npm run build          # esbuild bundle -> dist/extension.cjs
npm run test:host      # real VS Code host contracts (needs a display)
# Linux headless: xvfb-run -a npm run test:host
npm run package        # vsce package -> lunaroute.vsix
python3 tests/check-vsix.py lunaroute.vsix
python3 tests/check-vsix-negative.py lunaroute.vsix
# Installed-package host checks against the produced VSIX:
# xvfb-run -a npm run test:host -- --vsix lunaroute.vsix
```

The sandboxed toolchain used on the development machine (Node 24, Xvfb, the pinned VS Code build)
lives under ignored `.vscode-test/` with a command-local `PATH`; nothing is installed system-wide.

## Packaging rules

`vsce` packaging is deny-by-default (`.vscodeignore`), so anything new that must ship needs an
explicit include — and a matching entry in `tests/check-vsix.py`, which asserts the exact archive
allowlist, the manifest's `icon`/provider declarations, full license texts, and credential-shaped
canary strings (including the real `lr_` + 64-hex user-key format).

## Release flow

Version tag → tag/version validation (`tests/check-release-tag.mjs`) → the full CI workflow reused
via `workflow_call` → draft GitHub Release carrying the **tested** VSIX artifact. Marketplace
publishing is not automated; the current listing is uploaded by hand from the publisher management
page (**New extension → Visual Studio Code**, not the Visual Studio flow).

## Known open items

Deferred minors and open gates are tracked in `docs/smoke-checklist.md`, which stays the source of
truth; the kata ledger records the same items with attention state.
