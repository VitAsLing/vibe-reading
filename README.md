# Vibe Reading

Vibe Reading is a browser extension for reading and translating web pages with
local configuration and user-provided AI or translation providers.

This fork is intentionally narrow: **reading only**. It keeps the full-page
reading and translation workflow, removes the product-suite features around it,
and does not depend on a project-hosted backend. Features that need a network
service, such as AI translation, use the provider endpoints and API keys
configured by the user.

## Features

- 📖 Reading-first full-page translation.
- Full-page translation with bilingual and translation-only display modes.
- Paragraph and page-title translation for content-heavy pages.
- LLM-based language detection for auto-translate and skip-language rules.
- Context-aware AI translation using page content and summaries.
- Configurable AI and translation providers, including local or self-hosted
  provider endpoints.
- Custom prompts, translation styles, page rules, and batch/rate controls.
- No Notebase, hosted account, config backup, telemetry dashboard, or project
  backend dependency.

## Proudly Missing

Vibe Reading is smaller on purpose. Compared with the upstream Read Frog project,
Immersive Translate-style translation suites, browser built-in translators, and
general AI sidebar tools, this fork proudly avoids features that distract from
reading.

| Product or category                              | What they often include                         | What Vibe Reading proudly does not include                   | What Vibe Reading keeps                  |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| 🐸 Upstream Read Frog                            | Learning tools, hosted integrations, more modes | Notebase, hosted storage, Custom AI Actions, Beta Experience | Focused page reading and translation     |
| 🌊 Immersive Translate-style translation suites  | Broad translation surfaces across many media    | Video subtitles, input translation, overlay tools, TTS       | Web page reading translation             |
| 🌐 Browser built-in translators                  | Simple automatic page translation               | Browser-account coupling, opaque provider choice             | User-selected providers and local config |
| 🤖 General AI sidebar or assistant extensions    | Chat, writing, summarizing, action panels       | General AI workspace, prompt launcher, assistant overlay     | Translation prompts for reading context  |
| 📊 Productivity or telemetry-heavy browser tools | Dashboards, usage statistics, sync accounts     | Statistics, config backup, telemetry dashboard               | Local-only settings                      |

## Removed Upstream Features

| Removed capability                                     | Why it is absent                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 🗄️ Notebase hosted storage and backend-backed features | Vibe Reading does not rely on a project-hosted backend.                                   |
| 🧠 Custom AI Actions                                   | This fork is not a general AI action launcher.                                            |
| 🎬 Video Subtitles                                     | Video translation is outside the reading-only scope.                                      |
| ⌨️ Input Translation                                   | Vibe Reading avoids modifying text input workflows.                                       |
| 🧰 Overlay Tools                                       | Less overlay UI means fewer distractions on reading pages.                                |
| 🔊 Text to Speech                                      | Audio playback is outside the reading-only scope.                                         |
| 🔗 translation-hub                                     | No bundled upstream hub integration.                                                      |
| ☁️ Config Backup                                       | Vibe Reading keeps settings local and has no config sync, backup, import, or export flow. |
| 🧪 Beta Experience                                     | Experimental feature gates are removed.                                                   |
| 🚦 Extension Activation Mode                           | Page translation is controlled by direct translation actions and page rules.              |
| 📈 Statistics                                          | No local statistics dashboard or charting dependency.                                     |
| 🌍 Language Detection mode setting                     | Language detection always follows the LLM path; there is no basic/LLM mode knob.          |

The result is deliberately simple: **Vibe Reading is for reading.**

## Development

### API model catalog

The built-in text-generation model choices were checked on **2026-10-15** against
the [OpenAI catalog](https://developers.openai.com/api/docs/models),
[OpenAI shutdown notices](https://developers.openai.com/api/docs/deprecations), and
[DeepSeek's current models](https://api-docs.deepseek.com/quick_start/pricing/).
Newer generations appear first. DeepSeek offers `deepseek-flash` (V4.1 Flash) and
`deepseek-v4-pro`; its official Flash aliases are normalized to `deepseek-flash`.
Custom model names and third-party endpoints are preserved.

Shut-down models are removed from new selections. Existing selections remain
visible with a warning so updating the catalog cannot discard API keys or other
settings. Requests to a retired model at the official endpoint are rejected
until the reader selects a supported model. Models with future shutdown dates
remain available. Catalog presence does not establish access for a particular
API account.

```bash
pnpm install
pnpm lint
pnpm type-check
pnpm build
```

The pre-push hook checks lint and types. Existing unit tests remain available with
`pnpm test` or a focused `pnpm exec vitest run <path>`. The Build workflow is the
single PR validation entrypoint: it runs lint, types, existing unit tests, browser
packaging and loaded-extension E2E on Node 24.

The extension lifecycle E2E loads the production build into a disposable Chromium profile and exercises bilingual and translation-only modes. It covers background wakeup, individual retries in mixed inline/block content, reload with mounted error controls, dynamic content and SPA navigation, in-flight and silent extension reloads, page reload recovery, delayed success/failure after stop or element reuse, request ownership across sessions, cancellation before wrapper insertion, and out-of-order page language detection. It also covers same-URL source changes and detached error controls, independent keyboard/mouse presses with delayed configuration, iframe state rejection, late storage acknowledgements, settings startup failures and recovery, failed saves, theme/configuration freshness, and live shortcut updates. Model responses use a local HTTP fixture. Timing and failure injection occurs at Chrome storage/message, HTTP, locale-fetch, and animation-frame boundaries; internal extension functions are not mocked. No regular browser profile or production API key is read.

Locale scenarios exercise selected English/Chinese resources in opaque and
resource-restricted child frames, child reload, translation and stop, and a real
worker reload during pending locale delivery. Model scenarios use the actual
settings page to inspect retired selections, migrate equivalent Flash aliases,
save current models, reload settings, and translate through the installed SDK's
Responses or Chat Completions protocol against the local fixture.

```bash
pnpm build
pnpm exec playwright install chromium
pnpm e2e:extension
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/translation-only --translation-only
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-bilingual
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-translation-only --translation-only
```

Run these four groups sequentially. The native groups also cover concurrent
configuration editors, atomic save failures, background readiness, live queue
updates and save-confirmation ownership. Use `--case=<name>` for a focused
scenario and keep `E2E_NATIVE_VISIBILITY=1` for native-only cases; an inapplicable
case fails acceptance. Set `E2E_BROWSER_EXECUTABLE` to an existing Chrome for
Testing executable to check a specific browser version; otherwise the runner
uses Playwright Chromium. CI runs all four groups against the production Chrome
build after packaging and uploads acceptance artifacts separately from release
ZIPs, including when a scenario fails.

Playwright emulates page focus in the default two groups. Their configuration-refresh
scenario explicitly dispatches the public `visibilitychange` entry, so those
groups do not establish native tab hidden/visible transitions or native blur.
The two native groups attach without focus overrides and exercise real hidden
and frozen-page reloads. Authenticated X-page behavior and production
model-service behavior are outside all four groups' evidence.

A local request-queue deadline reports a timeout without automatically replaying
the provider request that is still pending. A late translation response cannot
replace that error or populate the translation cache; the reader can retry
explicitly. Completed remote HTTP failures retain their existing retry policy.
The local deadline does not cancel the original HTTP connection, and article
summary generation has separate SDK retries and cache behavior.

Artifacts in `.output/acceptance/extension-lifecycle` include the actual browser version, the revision and working-tree state, source/script/build hashes captured before launch, steps and assertions, HTTP and public-message records, worker stop/restart ordering, the Chrome extension error list, screenshots, and `trace.zip`. Inspect the trace with `pnpm exec playwright show-trace <path-to-trace.zip>`.

## License And Attribution

Vibe Reading is a modified fork of
[Read Frog](https://github.com/mengxi-ream/read-frog). Thanks to the Read Frog
authors and contributors for the original GPL-licensed work.

This project is distributed under the GNU General Public License version 3. See
[LICENSE](./LICENSE) for the full license text. As a modified version, Vibe
Reading preserves the GPLv3 terms, keeps the source available under the same
license, and marks the work as changed so issues in this fork are not attributed
to the upstream project.
