# Reload error acceptance — 1.34.7

Chrome can close an in-flight message channel before clearing the old content script's `runtime.id`. The released 1.34.6 build records a title translation failure in this window, including while its page is hidden and frozen. The shared error reporter now checks connection failures in the next lifecycle-owned task. Invalidation cancels that task; a still-valid extension reports the original failure. There is no request replay or additional retry. Timer completion and invalidation both remove the temporary lifecycle listener.

## Evidence

The production Chrome build passed 68 bilingual and 71 translation-only regression checks, plus four native-visibility checks in each mode: 147 checks total. Browser: Chrome for Testing 155.0.8059.39, disposable profiles. The executing host source was captured through `Debugger.getScriptSource`; its SHA256 matches the packaged host exactly:

`c5d55540fb1b94a504790c51f2cb2e66821c27803f0fd2e6a082512ab288e1ea`

The ZIP payload matches the immutable tested build. Type checking, lint, and Chrome/Edge/Firefox production packaging passed. Edge and Firefox were not runtime-tested.

Native scenarios use a separate browser attached with `noDefaults: true`. They do not emulate focus or visibility. All test browser launches use `--password-store=basic --use-mock-keychain` with disposable fixture data; no keychain authorization or personal browser profile is required.

- A real title HTTP request is held and its Chrome reply is asserted pending before the tab becomes hidden and frozen. Reload closes its channel while the old native runtime ID is still present. Resuming removes obsolete UI; old gestures stay inactive; refreshing restores translation. The final Chrome error collection is active and empty.
- While the extension remains valid, a real native title request is forwarded and its response boundary injects the same channel failure. The original error must appear in Chrome's collection. Only that saved and asserted error ID is removed from the disposable profile; the next title request succeeds. Unexpected errors still fail the final empty-list check.
- A provider failure mounts actual React error controls while real theme/configuration reads are held. Freeze, reload, resume, then release both reads. Late hydration must not remount old UI or reject an unhandled promise; refreshing and a fresh gesture recover translation.

Reports, commands, source/build hashes, Chrome errors, executing script IDs, storage/message records, screenshots and traces are under `.output/acceptance/reload-resume-20261013/` in `full-bilingual-normal`, `full-translationOnly-normal`, `native-bilingual`, and `native-translationOnly`. GitHub CI repeats these flows and uploads its own artifacts.

## Reproduction

```sh
pnpm build
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/full-bilingual
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/full-only --translation-only
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-bilingual --case=hidden-frozen-page-reload-recovery,live-channel-failure-stays-visible-and-recovers,pending-error-hydration-survives-frozen-reload
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-only --translation-only --case=hidden-frozen-page-reload-recovery,live-channel-failure-stays-visible-and-recovers,pending-error-hydration-survives-frozen-reload
```

Use the pinned pnpm 10.33.4. `E2E_BROWSER_EXECUTABLE` can select an installed official Chrome/Chromium executable; otherwise Playwright's installed Chromium is used. The focused frozen scenario also passed on bundled Chromium 153.0.8010.12.

## Ablation and limits

Removing the deferred check reproduces the released 1.34.6 Chrome error. Replacing it with blanket suppression loses the deliberately injected real failure and fails `live-channel-failure-stays-visible-and-recovers`. The temporary ablation source was restored. Keep the deferred validity check and listener cleanup.

The provider is a local OpenAI-compatible HTTP fixture. Faults/delays are at native API or HTTP boundaries; extension code, storage, messaging, workers and DOM are real. Authenticated X and production model services were not exercised. The previous user error's generic minified storage line cannot identify its executing script version; Chrome's displayed current file alone does not establish that identity.

The original regression suite keeps its focus emulation and popup-document adapter. An exploratory run of that suite without focus overrides was stopped when its existing two-animation-frame popup fence waited on a hidden document; it is not a production defect or passing evidence. The new native scenarios run separately, with explicit hidden/frozen assertions and no relaxed acceptance checks.
