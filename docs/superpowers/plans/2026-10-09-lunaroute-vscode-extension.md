# LunaRoute VS Code Chat + Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a desktop VS Code extension that obtains a LunaRoute key through browser signup/sign-in and supplies models to native Chat and Agent mode without manual key/configuration copying.

**Architecture:** One local UI extension owns credentials, discovery, and a stateless Responses adapter; VS Code owns agent execution and approvals. Small SaaS changes register `vscode` and preserve authorization through account setup. A short-lived navigation-intent cookie and a dashboard resume link reuse existing signup/billing screens rather than modifying Stripe checkout.

**Tech Stack:** TypeScript, VS Code stable Language Model Chat Provider/SecretStorage APIs, OpenAI JS SDK, esbuild, Vitest, Node assertions and `@vscode/test-electron`; existing SaaS Go/Fiber/sqlmock and Next.js/React/Vitest.

**Spec:** [Approved design](../specs/2026-10-09-lunaroute-vscode-extension-design.md), approved at `14e6210` on 2026-10-09. This plan still requires user review and an execution-method choice.

## Global Constraints

- "Users must not copy API keys or hand-edit provider configuration."
- "V1 supports desktop VS Code on Windows, macOS, and Linux, with local workspaces, Remote SSH, WSL, and Dev Containers."
- "Use stable, public VS Code APIs." Initial runtime baseline: **1.141.0**, the current stable release returned by Microsoft's update service on 2026-10-09. It is a test target, not an already-verified compatibility claim.
- "Ship one TypeScript extension with a Node entry point and `extensionKind: ["ui"]`."
- "SecretStorage is the only persistent store for the key." No plaintext fallback, remote credential files, production test hooks, or workspace-controlled endpoints.
- "Allow up to 15 minutes for the overall browser interaction, with visible Cancel." `LOGIN_TIMEOUT_MS = 900000`; exchange timeout **15000 ms**; catalog timeout **10000 ms**. The existing backend code TTL remains **60 seconds after approval**.
- "Preserve LunaRoute's existing SHA-256 **hex** challenge format." Generate verifier/state from 32/16 random bytes respectively, hex encoded.
- "Background activation and silent model discovery never open a browser or prompt for credentials."
- "No silent fallback to another model or provider." "No automatic inference retries, including SDK defaults"; no automatic exchange replay either.
- "Managed LunaRoute Responses routes are stateless": full host-supplied history, `store: false`, no `previous_response_id`.
- Preserve instruction content, tool IDs/results, supported images, and required replay data; unsupported non-empty parts are errors, not discarded content.
- Reject redirects on extension-issued exchange/catalog/inference requests. Never log keys, verifiers, codes, callback URLs, prompts, or tool/conversation contents.
- Sign-out is local; key revocation remains in the dashboard. Never overwrite the user's model or utility-model preferences.
- No autocomplete, browser-only VS Code, extra LunaRoute MCP-tool registration, custom chat UI, new analytics, or shared cross-repo SDK.
- Preserve signup invite/CAPTCHA rules, membership checks, billing eligibility, and CLI/Pi/OpenCode behavior. Do not run Terraform locally; this plan needs no Terraform change.
- No merge, live billing mutation, deployment, or Marketplace publication without the applicable owner authorization. A packaged VSIX is not a verified release.

## Review Focus

1. **Email verification opens in a new tab:** the pending VS Code destination must survive loss of `sessionStorage`; another email's verification must not consume that intent. Task 2.
2. **Sign-out/connection change races a delayed exchange, secure-store write, or stream:** obsolete results must not restore credentials/catalog or continue the previous connection's work. Tasks 4, 5, and 7.
3. **A callback or redirect contains duplicate parameters, hostile authority, or secret-looking error text:** reject it without consuming the valid attempt, forwarding credentials, or echoing secrets. Tasks 2, 4, and 6.
4. **Interleaved tool-call fragments end in a truncated/error stream:** never emit an incomplete/duplicate call or replay the request automatically. Task 6.
5. **A chat changes model while containing model-specific replay data, or the host supplies an unexpected content part:** preserve supported content and reject incompatible input explicitly; a mocked API alone cannot certify native Agent behavior. Tasks 6 and 7.

---

## Repository and execution setup

Use two explicit roots in the commands below:

- `$EXT`: the extension's isolated writer worktree. The documentation currently lives at `/mnt/work/lunaroute/lunaroute-saas/lunaroute-vscode-extension/.worktrees/b7rz-vscode-design`.
- `$SAAS`: a separately claimed SaaS worktree created from `/home/eran/work/lunaroute/lunaroute-saas`, following its `AGENTS.md` and begin-work skill. `$FRONT` means `$SAAS/services/lunaroute-front`.

Before implementation, inspect status, claim the appropriate kata work, establish/refresh each worktree's liveness lock, and record its branch. Never let two writers share either worktree. Reuse existing isolation rather than creating a nested worktree. Search the SaaS ledger before creating a related auth task. Deployment of Tasks 1–3 is a dependency of real browser-login smoke tests, not of local adapter development.

The extension started without commits; its documentation branch now has a root commit. The original checkout still contains the user's untracked `.gitignore` and `.kata.toml`. Preserve them. Task 4 incorporates their existing contents into the writer worktree before adding the extension's own ignores; do not overwrite or stage the original checkout. No remote repository or publication target has been created by this planning work. Verify the intended remote/default-branch bootstrap before attempting a first PR. The extension repo also has no stored Git author identity yet; documentation commits used per-command overrides from the matching identity in existing LunaRoute repos. Preserve that approach or obtain owner-approved repo-local configuration, never invent an identity or change global Git settings.

Record baseline checks in the SaaS worktree before changing it. Use its Go **1.27** toolchain and frontend **pnpm 10.28.0**. For extension development/CI use Node **24** and npm, but compile the extension for Node **22**. The planning machine currently has no `code`, Xvfb, or `xvfb-run`; real-host tests require a suitable desktop or CI runner, not an assertion that mocks passed.

Run extension commands from `$EXT`, frontend commands from `$FRONT`, and Go commands from `$SAAS/services/lunaroute-api`, even where a repeated `cd` is omitted below. Follow TDD for each task: add the named regression, observe its intended failure, implement only its owner, rerun focused tests, then commit the explicitly listed paths. Do not fix unrelated baseline failures. Keep commits in the owning repo and let its installed review hooks run.

## File responsibilities and shared contracts

### Extension

- `src/lunaroute.ts`: fixed origins, timeouts, attribution headers, and sanitized error categories shared by the three HTTP consumers.
- `src/auth.ts`: temporary loopback authorization, a single encrypted connection record, connection epochs/cancellation, secure-store events.
- `src/catalog.ts`: fetch/validate models, capability mapping, connection-scoped in-memory cache and refresh events.
- `src/responses.ts`: VS Code message conversion, real SDK transport/stream conversion, conservative token estimation.
- `src/provider.ts`: native `LanguageModelChatProvider` methods and connection/catalog wiring.
- `src/extension.ts`: commands, small management menu, progress notifications, registration and disposal; no exported activated credential API.
- `tests/*.test.ts`: unit/HTTP contract tests; `tests/vscode.ts` contains only the minimal API doubles they need.
- `tests/host-fixture/`: an explicitly test-only extension with its own SecretStorage and fake HTTP server, excluded from the VSIX.
- `tests/host/index.ts`, `tests/run-vscode.mjs`: real extension-host checks, using public APIs rather than source assertions.

### SaaS

- Existing device registry/page: add the new client and copy, without changing the protocol.
- New `lib/device-auth-return.ts`: bounded, strictly validated navigation intent, **not an authentication credential**.
- Existing sign-in/signup/verification components: carry that intent while retaining their current security gates.
- Device-auth layout/component: provision a first-time VS Code user through the existing sync helper and offer existing setup routes on authoritative setup errors.
- New `components/dashboard/DeviceAuthResumeLink.tsx`: explicit **Return to VS Code authorization** action on existing dashboard/billing/welcome screens.

Do not modify Stripe checkout payloads, billing projection, Go registration/verification APIs, email templates, or the existing general `safeCallbackUrl` validation algorithm to carry this return target.

## Task 1: Register the SaaS client and prove key provenance

**Files — SaaS:** Modify `services/lunaroute-api/internal/handlers/cli_auth.go` and `cli_auth_test.go`; modify `services/lunaroute-front/app/device-auth/[deviceName]/page.tsx` and `page.test.tsx`.

**Interfaces:** Consume the existing `AuthorizeDevice`, `Exchange`, `deviceAuthClients`, and `codeTTL` contracts. Produce an accepted `vscode` path segment and server-derived `source=vscode`, with label prefix `lunaroute-vscode `; no request/response schema change.

- [ ] **1. Add the failing handler and page regressions.** Extend the existing sqlmock/Fiber patterns rather than mocking handler behavior. Required assertions:

```go
// TestAuthorizeDeviceMintsCodeFromPathSegment: add a vscode case;
// expect INSERT cli_auth_codes source="vscode" and HTTP 200.
// TestExchangeMintsVSCodeKey: consumed source="vscode";
// expect INSERT api_keys name="lunaroute-vscode host", source="vscode";
// response.source == "vscode", full_key nonempty.
// TestExchangeEmptyVSCodeLabel: name == "lunaroute-vscode".
if got := codeTTL("vscode"); got != 60*time.Second { t.Fatalf("TTL: %s", got) }
```

Page test: `deviceName=vscode` renders **Authorize LunaRoute VS Code extension** and sends authorization through `/api/auth/device/vscode/authorize`. Keep unknown-device and client-supplied-source rejection tests.

- [ ] **2. Observe RED.** Run `cd "$SAAS/services/lunaroute-api" && go test ./internal/handlers -run 'Test(CodeTTL|AuthorizeDevice|Exchange.*VSCode)' -count=1`; run `cd "$FRONT" && pnpm exec vitest run 'app/device-auth/[deviceName]/page.test.tsx'`. Expect new acceptance/label/copy assertions to fail, not unrelated setup errors.
- [ ] **3. Implement the registry entry and page copy.** Keep the shared handler's membership/billing/PKCE behavior. Description: **A LunaRoute VS Code extension on this device is requesting access to your account. It will create an API key scoped to your organization.**
- [ ] **4. Verify GREEN and regressions.** Run `cd "$SAAS/services/lunaroute-api" && go test ./internal/handlers -run 'Test(CodeTTL|Authorize|Exchange)' -count=1`; run `cd "$FRONT" && pnpm exec vitest run 'app/device-auth/[deviceName]/page.test.tsx' 'app/api/auth/device/[deviceName]/authorize/route.test.ts'`. All pass; Go fixtures prove the source and name, not a grep of the registry.
- [ ] **5. Commit the four files.** Message: `feat(auth): register VS Code device authorization`.

## Task 2: Preserve signup and verification return intent

**Files — frontend:** Create `lib/device-auth-return.ts` and `lib/device-auth-return.test.ts`. Modify `app/auth/signin/page.tsx`, `components/auth/SignInPanel.tsx`, `components/auth/SignInForms.tsx`, `app/auth/signup/page.tsx`, `components/auth/SignUpForm.tsx`, `components/auth/VerifyEmailClient.tsx`, and their existing `*.test.tsx` counterparts.

**Interfaces produced by `lib/device-auth-return.ts`:**

```ts
export interface DeviceAuthReturn { path: string; expiresAt: number; email?: string }
export const DEVICE_AUTH_RETURN_COOKIE = "lr_vscode_auth_return";
export const DEVICE_AUTH_RETURN_TTL_MS = 900000;
export function normalizeDeviceAuthReturn(value: unknown): string | undefined;
export function readDeviceAuthReturn(cookieHeader: string, now: number): DeviceAuthReturn | undefined;
export function rememberDeviceAuthReturn(path: string, email?: string): boolean;
export function clearDeviceAuthReturn(path: string): void;
```

`readDeviceAuthReturn` is pure and usable with browser cookies or Next's request cookies. The write/clear functions are browser-only; writing returns false if storage/readback fails, and clearing removes only a matching path. Use one host-only, client-readable, `SameSite=Lax`, `Path=/` cookie, `Secure` on HTTPS, maximum age 900 seconds. It contains only the return path, expiry, and optional normalized signup email: never an API key, verifier, or authorization code. It is untrusted navigation state; it grants nothing. A new explicit flow replaces the previous intent; rewrites of the same live path preserve its original expiry.

Accept only the relative `/device-auth/vscode` path with exactly one each of `port` (decimal integer 1024–65535), `state` (32 hex characters), and `challenge` (64 hex characters). Reject duplicates, unknown parameters, fragments, controls, foreign/protocol-relative URLs, malformed JSON, and duplicate intent cookies. Limit the target and individual encoded cookie record to 2048 characters, not the entire Cookie header containing other session cookies. Rebuild the canonical path with `URLSearchParams`; never return the original unchecked string. Require integer expiry with `now < expiresAt <= now + 900000`.

- [ ] **1. Add failing parser and cross-tab tests.** Use the fixed fixture below; also assert malformed/duplicated `port`, `//evil.test`, `/\\evil.test`, arrays, `code=secret`, and expired records yield `undefined`, with no raw-value logging.

```ts
const target = `/device-auth/vscode?port=45117&state=${"a".repeat(32)}&challenge=${"b".repeat(64)}`;
expect(normalizeDeviceAuthReturn(target)).toBe(target);
expect(normalizeDeviceAuthReturn(target + "&state=other")).toBeUndefined();
expect(rememberDeviceAuthReturn(target, "Person@example.test")).toBe(true);
sessionStorage.clear(); // verification opened in a new tab
expect(readDeviceAuthReturn(document.cookie, Date.now())?.email).toBe("person@example.test");
```

Add component tests: Create account preserves this target; both signup methods retain it; after successful verification of that same email, manual and timed sign-in routes include `callbackUrl=target`. A different verified email must neither consume nor resume that email-bound intent. Explicit malformed callbacks must not be replaced by a cookie fallback. Ordinary signup/invites without a device intent retain current behavior.

- [ ] **2. Observe RED.** Run `cd "$FRONT" && pnpm exec vitest run lib/device-auth-return.test.ts app/auth/signin/page.test.tsx app/auth/signup/page.test.tsx components/auth/SignInForms.test.tsx components/auth/SignUpForm.test.tsx components/auth/VerifyEmailClient.test.tsx`.
- [ ] **3. Implement the helper and propagate `deviceAuthReturn?: string`.** Pass the validated path from SignInPage through SignInPanel/SignInForms into the signup link; remember it before leaving for OAuth. SignupPage uses a validated explicit target, or the cookie only when that parameter is absent, and passes it to SignUpForm and its sign-in footer; an explicitly invalid target is never repaired from a cookie. After successful password registration, associate the intent with that email. In VerifyEmailClient, add the validated matching target to both existing sign-in exits. Keep `rememberPendingVerifyEmail` and the 3-second forward/StrictMode guards unchanged.
- [ ] **4. Preserve trust boundaries and fallback.** Continue using `safeCallbackUrl` at every existing server-action boundary. Cookie fallback in SignInPage applies only when `callbackUrl` is absent and an email-bound intent matches the requested email; it never overrides an explicit invalid callback. Existing OAuth signup actions may still return to `/dashboard` for provisioning; Task 3 provides the resume link. For device signup, keep a visible completion note telling the user to return to the original tab after email verification. If writing the intent returns false, explain that recovery explicitly. Verification in another browser remains a normal sign-in there; the original device tab or a fresh **LunaRoute: Sign In** resumes setup without copying a key. Never claim an absent destination was retained.
- [ ] **5. Verify GREEN and auth regressions.** Run the focused command, `pnpm exec vitest run components/auth/SignInPanel.test.tsx app/auth/signup/actions.test.ts lib/verify-email-handoff.test.ts`, `pnpm exec tsc --noEmit`, and ESLint on touched TS/TSX files. Invitation, CAPTCHA, verification retry, and callback rejection tests stay green.
- [ ] **6. Commit this task's helper, callers, and tests.** Message: `fix(auth): retain VS Code authorization through signup`.

## Task 3: Complete provisioning and billing without changing checkout

**Files — frontend:** Modify `app/device-auth/[deviceName]/layout.tsx`, `components/DeviceAuthPage.tsx`, `components/DeviceAuthPage.test.tsx`, and `app/dashboard/[orgId]/layout.tsx`; create `app/device-auth/[deviceName]/layout.test.tsx`, `components/dashboard/DeviceAuthResumeLink.tsx`, and `DeviceAuthResumeLink.test.tsx`. Modify the existing `app/dashboard/[orgId]/layout.test.tsx`.

**Interfaces:** Consume Task 2's helper and existing `syncUserOrRedirect(email, name, freshSignup, freshSignupAt): Promise<SyncUserResponse>`. Produce `DeviceAuthResumeLink(): React.JSX.Element | null` and setup recovery for `USER_NOT_FOUND`, `NO_ORG`, and `SUBSCRIPTION_REQUIRED`; the device authorize API remains unchanged.

- [ ] **1. Add failing provisioning/setup tests.** Assert the authenticated `vscode` layout calls the real sync seam with session-derived reactivation fields before rendering; `pi`/`opencode` keep their old behavior. Assert signup-denied redirect propagation is not swallowed. A missing-plan error offers the chosen membership's `/dashboard/<orgId>/billing`; missing user/org offers `/dashboard`; network failure retains Retry rather than pretending billing is needed.

```tsx
// DeviceAuthResumeLink.test.tsx, after remembering Task 2's target:
render(<DeviceAuthResumeLink />);
expect(await screen.findByRole("link", { name: "Return to VS Code authorization" }))
  .toHaveAttribute("href", target);
// Repeat with an expired/malformed cookie: no link.
// Clearing target A must not remove a newer target B.
```

Test the link after a simulated full-page checkout return with empty sessionStorage and the same cookie, including dashboard/welcome rendering. Test that no authorization code is requested until the user returns and clicks Authorize.

- [ ] **2. Observe RED.** Run `cd "$FRONT" && pnpm exec vitest run 'app/device-auth/[deviceName]/layout.test.tsx' components/DeviceAuthPage.test.tsx components/dashboard/DeviceAuthResumeLink.test.tsx 'app/dashboard/[orgId]/layout.test.tsx'`.
- [ ] **3. Implement the narrow layout sync and resume UI.** Only `vscode` gets the added sync. Leave `auth.config.ts` as the sign-in redirect owner; a layout cannot reconstruct lost query parameters. Remember the current validated intent before a setup detour. Mount the small resume component in the existing org dashboard layout so billing and welcome share it. Read cookies on mount/focus, hide expired intent, and use house components/accessibility conventions. Keep the billing gate outside its existing catch block.
- [ ] **4. Complete callback recovery.** Retain DeviceAuthPage's automatic CORS delivery, user-initiated callback link, and `ph-no-capture` protections. Clear only this flow's intent after verified callback delivery; a failed/mismatched delivery keeps recovery available until expiry. Returning from billing never bypasses the backend's eligibility check or automatically authorizes a key.
- [ ] **5. Verify GREEN.** Run the focused command, the existing device page/proxy tests, `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm lint`. Record unrelated baseline failures separately. No changes to PlanPicker, Stripe request URLs, Go billing logic, or email templates should appear in the diff.
- [ ] **6. Commit the explicit task paths.** Message: `fix(auth): resume VS Code setup after account provisioning`.
- [ ] **7. Establish the live-test prerequisite.** Submit the SaaS commits for its normal PR/CI/review process and obtain owner-authorized deployment after its backend/frontend checks and build pass. Record the deployed commit. This can wait for the owner while Tasks 4–6 proceed, but Task 7's real-login checkpoint cannot pass without it. A plan or PR is not merge/deploy authorization.

## Task 4: Build a securely sign-in-capable extension

**Files — extension:** Create `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `src/lunaroute.ts`, `src/auth.ts`, `src/extension.ts`, `tests/vscode.ts`, `tests/auth.test.ts`, and `tests/lunaroute.test.ts`. Incorporate the existing `.kata.toml` unchanged and `.gitignore` contents with the new ignores in this writer worktree only.

**Package decisions:** Name `lunaroute`, display name `LunaRoute`, description **LunaRoute models in native VS Code Chat and Agent mode**, keywords `lunaroute`/`language-models`, license `MIT`, version `0.1.0`, provisional publisher `lunaroute` (ownership is a publication gate), `engines.vscode: ^1.141.0`, `type: module`, `main: ./dist/extension.cjs`, `extensionKind: ["ui"]`. Use `@types/vscode@1.140.0` (currently published; do not invent a 1.141 types release), `openai@7.32.0`, `@vscode/test-electron@3.1.0`, and `@vscode/vsce@4.0.0`. Add TypeScript, esbuild, Vitest, and Node-22 typings as dev dependencies and commit npm's resolved lockfile. `openai` is the sole runtime dependency.

Scripts: `typecheck` = `tsc --noEmit`; `test` = `vitest run` (only `tests/*.test.ts`); `check` = typecheck + unit tests; `build` = `esbuild src/extension.ts --bundle --platform=node --target=node22 --format=cjs --external:vscode --outfile=dist/extension.cjs`. Add ignores for `node_modules/`, `dist/`, `.vscode-test/`, `*.vsix`, and `.worktrees/` while retaining the original kata/roborev entries. No product `browser` entry point or proposed API flags. Set TypeScript strict mode, NodeNext module/resolution, ES2022 + DOM libs, noEmit, and include source/tests/config; Vitest aliases `vscode` to the small test double, while type checking still uses real VS Code declarations. Resolve/install these dependencies only during implementation, not while reviewing this plan.

**Interfaces produced:**

```ts
// src/lunaroute.ts
export interface Attribution { version: string; sessionId: string }
export type FailureKind = "auth" | "policy" | "billing" | "rate-limit" | "network"
  | "upstream" | "storage" | "input" | "protocol" | "cancelled";
export class LunaRouteError extends Error {
  constructor(kind: FailureKind, status?: number, retryAfterSeconds?: number);
  readonly kind: FailureKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}
export function buildHeaders(key: string, attribution: Attribution): Record<string, string>;
export function userMessage(error: unknown): string;
export const FRONT_URL = "https://app.lunaroute.com";
export const API_URL = "https://api.lunaroute.com";
export const ROUTING_URL = "https://gw.lunaroute.com/v1";
export const LOGIN_TIMEOUT_MS = 900000;
export const EXCHANGE_TIMEOUT_MS = 15000;
export const CATALOG_TIMEOUT_MS = 10000;

// src/auth.ts
export interface Connection { readonly apiKey: string; readonly orgId: string; readonly email?: string }
export interface AuthSnapshot { readonly connection?: Connection; readonly epoch: number; readonly signal: AbortSignal }
export interface AuthController extends vscode.Disposable {
  readonly onDidChange: vscode.Event<void>;
  snapshot(): AuthSnapshot;
  signIn(token: vscode.CancellationToken): Promise<void>;
  signOut(): Promise<void>;
}
export async function createAuthController(
  secrets: vscode.SecretStorage,
  openExternal: (url: string) => Promise<boolean>,
  deps?: { fetch?: typeof fetch; apiUrl?: string; frontUrl?: string; hostname?: string }
): Promise<AuthController>;
```

Test injection is not read from configuration/environment in the shipped activation path. Store one validated JSON connection under `lunaroute.connection`; never split key and organization into independently updated records. Exchange validation requires `source: "vscode"`, a nonempty printable-ASCII `full_key` of at most 512 characters, a UUID `org_id`, and optional string `user_email`; empty email is omitted. Callback code is a single URL-safe token of 1–512 characters, and state must exactly match the generated 32-character value. Headers include `Authorization`, `lunaroute-agent: vscode/<version>`, and the same activation-random UUID in `x-lunaroute-session` and `lunaroute-session-id`. `userMessage` uses static categories/statuses, never raw SDK/server error text.

- [ ] **1. Add failing tests and only the tooling needed to run them.** A real local callback listener plus a controlled exchange server must prove PKCE format, state binding, single exchange, source response validation, and secure-store success before success notification. Include all timeout/error cases below and the delayed-write/two-controller race cases described in Step 4 before implementing the lifecycle.

```ts
// tests/auth.test.ts — controlled exchange returns the wire fields for this record.
const connection = { apiKey: "lr_test_key_not_real",
  orgId: "00000000-0000-4000-8000-000000000001", email: "person@example.test" };
// Capture authorizeUrl via injected openExternal; send real HTTP callbacks.
expect(authorizeUrl.pathname).toBe("/device-auth/vscode");
expect(authorizeUrl.searchParams.get("state")).toMatch(/^[a-f0-9]{32}$/);
expect(authorizeUrl.searchParams.get("challenge")).toMatch(/^[a-f0-9]{64}$/);
expect(exchangeBody).not.toHaveProperty("source");
expect(createHash("sha256").update(exchangeBody.verifier).digest("hex"))
  .toBe(authorizeUrl.searchParams.get("challenge"));
const stored = await secrets.get("lunaroute.connection");
expect(stored).toBeDefined();
expect(JSON.parse(stored!)).toEqual(connection);
```

Also pin: wrong/duplicate state/code, wrong Host/path/method, browser-open failure, valid-origin CORS/preflight vs manual GET, two simultaneous callbacks, timeout at **900000 ms**, exchange timeout at **15000 ms**, cancellation/deactivation, redirects, malformed response, storage write/delete failure, and sanitized errors. A bad callback must leave a later valid callback usable; no key or code appears in the HTML response.

- [ ] **2. Observe RED.** Run `cd "$EXT" && npm test -- tests/auth.test.ts tests/lunaroute.test.ts`; missing exports or the new behavior must fail, not dependency resolution.
- [ ] **3. Implement the shared protocol helpers and auth lifecycle.** Bind only `127.0.0.1:0`. Use a generation for pending login and a connection epoch/AbortController for catalog/inference. Serialize local secret mutations, cancel superseded attempts, and recheck generation after every await before committing state. Subscribe to SecretStorage changes to invalidate obsolete work in other windows. Never perform a late unconditional delete that could remove a newer key. If delete fails, report incomplete sign-out rather than claiming the persistent key is gone.
- [ ] **4. Verify the race regressions before wiring UI.** Run `npm test -- tests/auth.test.ts tests/lunaroute.test.ts`. The tests written in Step 1 hold exchange/store promises, then sign out or deliver a newer SecretStorage change; assert no stale success/cache/credential replacement. A pending-store-then-delete sequence must settle signed out. Use two controllers sharing a store for change propagation. Separate windows converge through store events; do not claim SecretStorage provides a cross-process compare-and-swap primitive. Truly simultaneous explicit sign-ins may settle to the last successful store, but an observed invalidated attempt cannot commit.
- [ ] **5. Implement `activate(context: vscode.ExtensionContext): Promise<void>` and `deactivate(): void`.** Register `lunaroute.signIn`, `lunaroute.signOut`, and `lunaroute.manage` with native commands/menu and cancellable progress. Management opens `https://app.lunaroute.com/dashboard`; sign-out explains local-only deletion. Silent activation reads the store without prompting. Generate attribution once per activation. Return no credential-bearing extension API and dispose all resources.
- [ ] **6. Verify.** Run `npm run check && npm run build`; all checks pass. Inspect the diff for files outside this task and plaintext secrets.
- [ ] **7. Commit the listed package/auth files.** Message: `feat: add secure browser sign-in to VS Code`.

## Task 5: Discover compatible models and invalidate stale catalogs

**Files — extension:** Create `src/catalog.ts` and `tests/catalog.test.ts`; consume Task 4's protocol/error/auth types.

**Interfaces produced:**

```ts
export function mapCatalog(payload: unknown): vscode.LanguageModelChatInformation[];
export class Catalog implements vscode.Disposable {
  constructor(auth: AuthController, attribution: Attribution,
    deps?: { fetch?: typeof fetch; url?: string });
  readonly onDidChange: vscode.Event<void>;
  get models(): readonly vscode.LanguageModelChatInformation[];
  get failure(): LunaRouteError | undefined;
  refresh(token: vscode.CancellationToken): Promise<readonly vscode.LanguageModelChatInformation[]>;
  dispose(): void;
}
```

- [ ] **1. Add failing validation and lifecycle tests.** Pin this model mapping and exclusion of malformed limits, duplicate/empty IDs, nonboolean capability values, and non-chat families. Also write the HTTP/cancellation/race cases enumerated in Step 4 now. Use the raw catalog ID on requests; never prepend the vendor.

```ts
const [model] = mapCatalog({ data: [{ id: "chat-a", display_name: "Chat A",
  context_window: 131072, max_output_tokens: 8192,
  capabilities: { tools: true, vision: true } }] });
expect(model).toMatchObject({ id: "chat-a", name: "Chat A",
  maxInputTokens: 122880, maxOutputTokens: 8192,
  capabilities: { toolCalling: true, imageInput: true } });
expect(() => mapCatalog({ data: {} })).toThrow(LunaRouteError);
expect(mapCatalog({ data: [] })).toEqual([]);
```

Absent tools/vision means false. Exclude `image_generation`, `embeddings`, `rerank`, `transcription`, and `systemone`; validate positive safe-integer limits and require context > output. Use catalog family/version when valid, otherwise ID/`"1"`, not guessed model-family parsing.

- [ ] **2. Observe RED.** Run `cd "$EXT" && npm test -- tests/catalog.test.ts`.
- [ ] **3. Implement mapping and refresh.** Fetch the fixed `/models` endpoint with the current snapshot key and attribution, redirect rejection, and **10000 ms** timeout. Coalesce refreshes for the same epoch. Connection changes/timeouts abort the shared fetch; an individual caller cancels only its own wait, and the shared request is aborted once all waiters have cancelled. One caller must not cancel another waiter's refresh. Retain only same-connection in-memory metadata on transient failure; invalidate on sign-out, key change, or confirmed 401/403. Successful empty data replaces old models. Publish an event only for current-epoch results; never cache a failed in-flight promise.
- [ ] **4. Verify HTTP and race tests.** Controlled HTTP responses prove headers, no redirects, timeout, single request for concurrent refreshes, independent waiter cancellation, explicit retry after failure, empty results, old-fetch completion after key replacement, and management-visible failure without a fake model. Run `npm test -- tests/catalog.test.ts && npm run typecheck`.
- [ ] **5. Commit the two files.** Message: `feat: discover LunaRoute chat models for VS Code`.

## Task 6: Translate Responses streams without losing Agent history

**Files — extension:** Create `src/responses.ts`, `tests/responses.test.ts`, and `tests/fixtures/responses-sse.ts`; extend `tests/vscode.ts` only for the real public classes used. Do not mock the OpenAI SDK's request or stream logic.

**Interfaces:** Consume Task 4's Attribution/errors and Task 5's validated model information. Produce the adapter and shared test-fixture functions below.

```ts
export function buildResponsesRequest(
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions
): OpenAI.Responses.ResponseCreateParamsStreaming;
export function streamResponse(
  key: string, request: OpenAI.Responses.ResponseCreateParamsStreaming,
  attribution: Attribution, signal: AbortSignal, baseURL?: string
): AsyncGenerator<vscode.LanguageModelResponsePart>;
export function estimateTokens(input: string | vscode.LanguageModelChatRequestMessage): number;

// tests/fixtures/responses-sse.ts — reused by Task 7, never shipped.
export function startGatewayFixture(handler: http.RequestListener): Promise<{
  origin: string; baseURL: string; close(): Promise<void>;
}>; // baseURL = origin + "/v1"
export function writeSse(res: http.ServerResponse,
  events: readonly { event: string; data: unknown }[], end?: boolean): void;
```

`baseURL` is for controlled-server tests; shipped callers omit it. Use SDK `maxRetries: 0` and `logLevel: "off"`, a redirect-rejecting fetch, a **120000 ms** connection/stream-idle limit, and abort/dispose its timer on every exit. This is a fixed safety limit, not a new setting; real-model smoke tests must validate it.

- [ ] **1. Add failing adapter tests.** Write the conversion assertions below and the stream/replay/token cases specified in Steps 4–6 before implementing their bodies. Native constructors have these stable signatures: `LanguageModelToolCallPart(callId, name, input)` and `LanguageModelToolResultPart(callId, content)`. Pin a complete two-turn tool exchange:

```ts
const model: vscode.LanguageModelChatInformation = {
  id: "chat-a", name: "Chat A", family: "chat-a", version: "1",
  maxInputTokens: 122880, maxOutputTokens: 8192,
  capabilities: { toolCalling: true, imageInput: true }
};
const messages = [
  vscode.LanguageModelChatMessage.User("Read the file"),
  vscode.LanguageModelChatMessage.Assistant([
    new vscode.LanguageModelToolCallPart("call-1", "read_file", { path: "a.ts" })]),
  vscode.LanguageModelChatMessage.User([
    new vscode.LanguageModelToolResultPart("call-1", [new vscode.LanguageModelTextPart("contents")])])
];
const request = buildResponsesRequest(model, messages, {
  toolMode: vscode.LanguageModelChatToolMode.Required,
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }]
});
expect(request).toMatchObject({ stream: true, store: false, tool_choice: "required" });
expect(request).not.toHaveProperty("previous_response_id");
expect(request.input).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call-1" }));
expect(request.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call-1" }));
```

Cover multiple calls/results interleaved with text, image inputs/results, and unsupported nested parts. Stable 1.141 exposes User/Assistant roles, not a public System enum: preserve host instruction text as supplied, never invent an enum member or rewrite instructions. Unknown roles/parts must raise a sanitized input error. Do not spread arbitrary `modelOptions` into requests; no custom tuning UI is in scope.

- [ ] **2. Observe RED.** Run `cd "$EXT" && npm test -- tests/responses.test.ts`.
- [ ] **3. Implement request conversion.** Preserve order while producing text/image message items, `function_call` items, and `function_call_output` items. Encode supported `LanguageModelDataPart` images as data URLs; map text MIME data as text; fail clearly for unsupported representations. Respect tools/capabilities and Required mode, including rejecting Required with no tools. Set output limits from validated model information. Never retrieve external attachment URLs or execute tools here.
- [ ] **4. Implement streamed conversion using the real SDK and a local SSE server.** Emit text deltas immediately. Index tool fragments by their output item identity, retain `call_id` separately, and validate complete JSON object arguments. Buffer completed tool calls until successful terminal completion, then emit once in order; an error/EOF after partial text must not emit a tool or trigger another POST. The Step 1 tests cover two interleaved calls, duplicate done events, malformed arguments, upstream errors, missing terminal event, redirect, rate limit, idle timeout, and cancellation after a text delta. Catch SDK/parser errors before they leave this module and throw only sanitized LunaRouteError categories; do not retain raw secret-bearing errors in a cause chain. With `OPENAI_LOG=debug` in the test environment, assert that SDK/app logs still contain neither the fake key nor probe prompt/tool content.
- [ ] **5. Implement the tested replay contract rather than claiming compatibility.** Use an opaque assistant `LanguageModelDataPart` MIME `application/vnd.lunaroute.responses-replay+json` only for required reasoning items, with a validated `{ modelId, item }` envelope. Accept only same-model assistant reasoning items with allowed Responses fields, not arbitrary objects/instructions/tools from this MIME. Never emit reasoning as normal answer text. Cross-model or unsupported opaque data gives an actionable new-chat/input error. Test exact round trips; Task 7 must prove the real host retains these parts. If it does not, stop and report the stable-API limitation before advertising affected models—do not silently drop data or enable proposed APIs.
- [ ] **6. Implement the tested token estimate.** Text uses UTF-8 byte length; messages add 32 tokens of framing, and tool calls/results add 32 plus their textual/JSON byte counts. Budget **16384 per image**, not its base64 characters as text. Replay data includes its serialized byte count. Unsupported parts fail consistently with request conversion. Pin non-ASCII, nested tool data, and image cases; document this conservative estimate with a `shortcut:` comment explaining upgrade to model-aware tokenization when available. Pin `estimateTokens("猫") === 3` and one image-only User message to `32 + 16384`; tool JSON/text is counted once, not again as its enclosing serialized message. Calibration against real near-limit requests in Task 8 is required; do not claim exact counts.
- [ ] **7. Verify.** Run `npm test -- tests/responses.test.ts && npm run typecheck`; all tests pass. Inspect captured HTTP: one POST, full history, `store:false`, attribution, no unexpected fields/credentials in diagnostics.
- [ ] **8. Commit the adapter and tests.** Message: `feat: bridge VS Code messages to LunaRoute Responses`.

## Task 7: Wire the native provider and verify the actual extension host

**Files — extension:** Create `src/provider.ts`, `tests/provider.test.ts`, `tests/host-fixture/package.json`, `tests/host-fixture/extension.ts`, `tests/host/index.ts`, `tests/run-vscode.mjs`, and `docs/smoke-checklist.md`; modify `src/extension.ts`, `package.json`, `package-lock.json`, and `tsconfig.json` for test build inclusion.

**Interfaces:** Consume AuthController/Catalog and Task 6's three functions. Produce:

```ts
export class LunaRouteProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  constructor(auth: AuthController, catalog: Catalog, attribution: Attribution,
    respond?: typeof streamResponse); // default is the real Task 6 transport
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
  provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]>;
  provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken): Promise<void>;
  provideTokenCount(model: vscode.LanguageModelChatInformation,
    input: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken): Promise<number>;
  dispose(): void;
}
```

- [ ] **1. Add failing provider tests.** Assert silent signed-out discovery returns `[]` without opening a browser, valid sign-in publishes models, refresh failure does not create a fake login model, and requests never run under an obsolete connection. Cancellation becomes VS Code cancellation rather than a scary toast. Tool parts are reported, never passed to `lm.invokeTool` by this extension. Test error categories/action labels and retention of user model/utility preferences.
- [ ] **2. Observe RED.** Run `cd "$EXT" && npm test -- tests/provider.test.ts`.
- [ ] **3. Implement the provider and final activation wiring.** Register `lunaroute` in both the manifest's `languageModelChatProviders` and the API, with `managementCommand: lunaroute.manage`. Add `lunaroute.refreshModels`. Use catalog events, current auth snapshots, and both caller/connection abort signals. Activation with a key refreshes without prompting; errors are visible through management or the explicit operation, not repeated startup dialogs. Provider management opens a menu, not automatic login. Dispose all listeners and abort controllers.
- [ ] **4. Add real-host contract checks.** The test-only fixture extension has vendor `lunaroute-probe`, its own SecretStorage, and Task 6's controlled HTTP fixture. Inject its origin into auth, its model URL into Catalog, and a `respond` closure forwarding to the real `streamResponse(..., fixture.baseURL)` into the provider. Product activation passes no overrides. The fixture must not expose or use the product's stored connection. `tests/host/index.ts` exports `run(): Promise<void>` using Node assertions. Test actual classes/registration, selecting a probe model, text/tool/image/replay round trips, model-change events, cancellation, and real SecretStorage events. Separately activate the real product and exercise its signed-out commands; do not ship a credential-bearing test API from `activate`.
- [ ] **5. Define and run `test:host`.** Build fixture and host-test entries with esbuild (`vscode` external); use `@vscode/test-electron` to launch **1.141.0** with isolated temporary user/extension directories and both development extensions. Run `npm run check && npm run build`; on a desktop run `npm run test:host`; on Linux CI run `xvfb-run -a npm run test:host`. Expected: provider/API contract checks pass with no real credentials. If the runner is unavailable here, run CI or obtain a suitable host; do not substitute mock evidence.
- [ ] **6. Perform a native Chat/Agent compatibility checkpoint.** In a disposable test workspace on the baseline release, use a real test account after Tasks 1–3 are deployed with approval. Verify the built-in Chat/Agent caller actually preserves tool, image, and required opaque history—not just direct `lm.sendRequest` test calls. Unexpected PromptTsx/role/replay requirements are a blocker to advertising the affected capability and must be brought back to the owner, not normalized by guesswork. Create `docs/smoke-checklist.md` in this task and record the redacted environment/version/model, expected/actual result, date, and evidence. Task 8 extends that same checklist.
- [ ] **7. Commit provider, integration tests, and manifest changes.** Message: `feat: expose LunaRoute in native VS Code Chat and Agent`.

## Task 8: Package, document, and collect release evidence

**Files — extension:** Create `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `.vscodeignore`, and `.github/workflows/check.yml`; modify `docs/smoke-checklist.md` and `package.json`/lockfile for packaging. SaaS verification stays in its own worktree/CI; no extension workflow should silently mutate or deploy that repo.

**Interfaces:** Consume the implemented extension and deployed SaaS prerequisites. Produce `lunaroute.vsix`, reproducible CI checks, and an evidence checklist; no automatic publishing workflow.

- [ ] **1. Write the release checks before packaging.** README must cover installation, Sign In/signup, native model selection, local extension placement for SSH/WSL/containers, desktop network requirements, utility-model setup without GitHub, 401/403/402/429 recovery, local-only sign-out, failed-login orphan-key cleanup, approximate token counts, and excluded features. Copy the sibling Pi extension's MIT LICENSE with its LunaRoute notice intact; include the installed SDK's and any bundled dependencies' required license/notice texts in `THIRD_PARTY_NOTICES.txt`. Document model-specific replay/new-chat restrictions as well as token estimates. Extend Task 7's smoke checklist, which records environment/version/model, expected result, actual result, date, and redacted evidence; mark unrun checks as unrun, never passed.
- [ ] **2. Implement packaging/CI.** Add `vscode:prepublish = npm run check && npm run build` and `package = vsce package --no-dependencies --allow-missing-repository --out lunaroute.vsix`. The missing-repository allowance is for local/CI VSIX builds until the owner supplies the real source URL, not permission to publish incomplete metadata. Bundle the SDK; include only the runtime bundle and required generated legal notices, manifest, README, LICENSE, and THIRD_PARTY_NOTICES. Exclude tests/fixtures, `.worktrees`, `.kata*`, `.roborev`, source maps, caches, and all VSIX files. CI uses Node 24 and `npm ci`; runs check/build on Windows/macOS/Linux, the real-host tests on Linux with Xvfb, and uploads a VSIX artifact. Do not add publishing credentials or bypass user trust/approval controls.
- [ ] **3. Verify the packaged contents, not just a manifest.** Run `cd "$EXT" && npm ci && npm run check && npm run build && npm run package`; inspect `unzip -l lunaroute.vsix` (or the platform's ZIP reader), install the VSIX into a disposable profile, and confirm activation/commands/model registration. Scan the archive for test fixture modules, credentials, and unintended files. Confirm publisher ownership and the real repository URL before publication; provisional `lunaroute` metadata is not evidence of ownership. Required third-party license texts must be present in the archive.
- [ ] **4. Run the SaaS gates in its worktree.** Run `cd "$SAAS/services/lunaroute-api" && go test ./...`; run `cd "$FRONT" && pnpm test && pnpm exec tsc --noEmit && pnpm lint && pnpm build`. Preserve baseline exceptions as named blockers, not green claims. Reverify the authorized SaaS deployment established after Task 3, including its deployed commit and recognition of `vscode`, before the packaged-extension login checks.
- [ ] **5. Execute the real smoke matrix with a test organization.** Local packaged installs on Windows/macOS/Linux; at least one Remote SSH, WSL, and Dev Container workspace; existing-user login; fresh password and OAuth signup; new-tab email verification; required organization/plan setup and return; blocked automatic loopback delivery with manual-link recovery; Chat streaming; multi-step Agent read/edit/terminal with normal approvals; vision/reasoning replay; fresh profile without GitHub/Copilot sign-in; near-context-limit multilingual/image/tool inputs; restart/revoked key/rate and billing errors; cancellation; two-window key changes/sign-out. Never use a real customer's conversation or incur live billing mutations without authorization.
- [ ] **6. Resolve evidence-driven limits before claiming support.** Calibrate the 16384-image/token estimates and 120000-ms idle limit against representative supported models. Unsupported native history, missing test environments, policy blocks, or pending SaaS deployment remain explicit release blockers. Do not quietly remove approved Chat/Agent/remote/signup requirements to make the checklist green.
- [ ] **7. Commit the release artifacts' source files and evidence document, not the VSIX.** Message: `build: package and verify LunaRoute for VS Code`. Keep a final diff/status review and the project's code-review evidence. Do not merge or publish without owner authorization.

## Plan self-review and handoff

Coverage: Tasks 1–3 implement the SaaS client and signup/billing return; Task 4 owns credentials/security/UI foundation; Task 5 owns discovery; Task 6 owns stateless Chat/Agent transport and estimates; Task 7 proves native integration; Task 8 covers packaging, platform support, end-to-end behavior, and release gates. Every Review Focus item has named owner tests above.

The key implementation risks are real-host replay compatibility, first-time account provisioning, browser loopback policy, and cross-window cancellation. Tooling/package metadata and source inspection were checked during planning; **no plan task, dependency installation, product test, deployment, or runtime smoke check has been executed yet**.

Recommended execution: **Native/direct implementation**, sequentially across the two worktrees, because auth, model discovery, and streaming share small interfaces and the SaaS frontend changes are closely coupled. A final fresh-context review is valuable, but delegation must be explicitly authorized by the selected execution method. Subagent-driven execution is an alternative with a fresh implementer/reviewer per task and higher context cost. Review this plan and choose the execution method before implementation.
