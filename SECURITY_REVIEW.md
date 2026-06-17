# Security Review

## Scope

This fork is intended for personal-use browser extension builds.

The goal of this review is to document the extension's current security shape before building release artifacts from this fork. It does not certify the extension as safe for high-risk browsing sessions.

## Network behavior

Translation and summary generation requests are sent through the configured AI provider selected in extension settings. The current provider types are OpenAI, DeepSeek, and OpenAI-compatible providers. OpenAI-compatible providers use the user-configured `baseURL`; OpenAI and DeepSeek are created through their AI SDK provider packages.

Other network-capable paths found during review:

- `src/entrypoints/background/proxy-fetch.ts` exposes a background `fetch` helper to extension contexts.
- `src/entrypoints/options/pages/api-providers/provider-config-form/components/model-suggestion-button.tsx` fetches `${baseURL}/models` for a user-configured provider when the user asks to fetch model suggestions.
- `src/utils/logo.ts` builds provider icon URLs under `https://registry.npmmirror.com/@lobehub/icons-static-webp/1.65.0/files/...`.
- `src/utils/iconify/setup-background-fetch.ts` configures Iconify fetches through the background fetch helper for content-script UI icons.
- `scripts/scrape-ai-sdk-provider-models.ts` uses `https://ai-sdk.dev` in a developer script, not in normal extension runtime.

Hardcoded network endpoints or external URLs found in runtime or project configuration:

- `https://registry.npmmirror.com/@lobehub/icons-static-webp/1.65.0/files/...`
- `https://platform.openai.com`
- `https://platform.deepseek.com`
- `https://api.example.com/v1`
- `https://ai-sdk.dev/providers/ai-sdk-providers`
- `https://en.wikipedia.org/wiki/Token_bucket`
- `https://ai-sdk.dev`
- `https://ui.shadcn.com/schema.json`
- `https://reui.io/r/{name}.json`

The `README` files also link to the upstream Read Frog project. Tests contain many `example.com` URLs; those are test fixtures.

## Secrets

Provider API keys are stored in the extension's local config storage under `local:${CONFIG_STORAGE_KEY}` through WXT storage. They are part of provider configuration, not repository files.

Development builds can read `WXT_<PROVIDER>_API_KEY` environment variables in `src/utils/config/init.ts`, but only when `import.meta.env.DEV` is true.

GitHub Actions do not use provider API keys. The build workflow installs dependencies, runs checks, builds, packages zip files, and optionally creates a GitHub Release using the built-in `GITHUB_TOKEN`.

API keys must never be committed to this repository. Do not put real keys in `.env`, test fixtures, screenshots, logs, issue text, or release notes.

## Browser permissions

The WXT manifest configuration in `wxt.config.ts` declares these permissions:

- `storage`
- `tabs`
- `alarms`
- `scripting`
- `webNavigation`

It declares this host permission:

- `*://*/*`

It also exposes packaged image assets to:

- `*://*/*`
- `file:///*`

Broad host permissions are needed because page translation injects scripts and UI into arbitrary webpages and frames selected by the user. The same broad permission increases the risk of using the extension on sensitive pages.

Avoid or exclude sensitive sites such as banking, brokerage, crypto exchange, wallet, Gmail, and company admin pages. Do not translate pages that contain secrets, private account data, seed phrases, internal documents, or regulated financial information.

## Telemetry

No project-hosted telemetry, analytics, account system, or backend calls were found in the runtime code search.

The `README.md` explicitly describes the project as local-only and says it has no hosted account, config backup, telemetry dashboard, or project backend. The runtime network behavior found in this review is provider/API calls, model-list calls, and UI asset/icon loading.

## Message passing

The extension uses typed internal messaging via `@webext-core/messaging` in `src/utils/message.ts`.

Background handlers are registered for translation state, translation requests, LLM generation, cache cleanup, opening options, iframe injection, and background fetches. Content scripts and extension pages can call these handlers.

No `externally_connectable` manifest entry, `runtime.onMessageExternal`, `window.postMessage` bridge, or page-to-extension message bridge was found. Based on the current code, arbitrary webpages cannot directly trigger privileged background actions. A webpage can still influence what the content script sees because the content script runs in the page and reads page text for translation.

## Build provenance

Packaged artifacts are produced by GitHub Actions from this fork.

The build workflow uses Node.js 22, Corepack, pnpm lockfile enforcement, existing project checks, `pnpm build`, and `pnpm zip:all`. Zip files from `.output/**/*.zip` are uploaded as workflow artifacts. For tags matching `v*`, the release job creates a GitHub Release and attaches the generated zip files without requiring external secrets.

## Manual review checklist

- [ ] Inspect `package.json` scripts: `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build`, `pnpm zip:all`.
- [ ] Inspect `wxt.config.ts` for manifest permissions, host permissions, web-accessible resources, and browser-specific settings.
- [ ] Search for network calls: `rg -n "fetch\\(|XMLHttpRequest|WebSocket|EventSource|navigator\\.sendBeacon|https?://" . -g '!node_modules' -g '!pnpm-lock.yaml'`.
- [ ] Search for telemetry terms: `rg -n "analytics|telemetry|sentry|plausible|segment|amplitude|gtag|mixpanel" . -g '!node_modules'`.
- [ ] Search for external message bridges: `rg -n "externally_connectable|onMessageExternal|postMessage|window\\.addEventListener\\(['\\\"]message" . -g '!node_modules'`.
- [ ] Inspect `src/utils/message.ts` for the internal message protocol.
- [ ] Inspect `src/entrypoints/background/index.ts` and background modules for registered handlers.
- [ ] Inspect `src/utils/config/init.ts`, `src/utils/config/storage.ts`, and provider config schemas for API key storage.
- [ ] Run `pnpm install --frozen-lockfile`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm type-check`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] Run `pnpm zip:all`.
