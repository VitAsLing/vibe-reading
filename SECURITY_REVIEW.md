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

The Build workflow uses Node.js 24, Corepack, pnpm lockfile enforcement, existing project checks, and `pnpm zip:all` to build and package Chrome, Edge, Firefox, and source archives. It validates package versions and runs loaded-extension E2E before uploading the packages and acceptance artifacts separately.

Pushes to `main` create a release tag matching `package.json`; an existing tag fails the release rather than replacing its artifacts. Tag-triggered builds also validate that the tag matches the package version. A separate manual Release Extension workflow can rebuild assets for an existing tag.

## Reviewing changes

Use the [development and acceptance instructions](README.md#development) for current commands, scenarios, and evidence limits. Review `wxt.config.ts`, `src/utils/message.ts`, background handlers, and provider/config storage paths when permissions, network behavior, messaging, or secrets handling change.

CI uses disposable browser profiles and local model fixtures. Its browser results establish extension behavior, not the reliability of a production model service or the safety of translating a sensitive page.
