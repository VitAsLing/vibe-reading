# Extension asynchronous boundary acceptance — 1.34.6

The packaged production Chrome extension was loaded in Chrome for Testing 155.0.8059.39 with disposable profiles. All 67 bilingual and 70 translation-only scenarios passed. Chrome extension error collection was active; both lists were empty, with no unhandled browser errors or CDP exceptions.

## Confirmed behavior

The original lifecycle suite remains intact. The additional scenarios exercise manual and page translations while the site changes source text, replaces content or elements, or removes pending/mounted error controls without changing the URL. Source nodes recreated with identical HTML still invalidate the obsolete operation. Stopping or navigating also cancels manual work. Late success/failure cannot mount obsolete controls, block a new gesture, or restore previous source. Only mode has one canonical restoration owner, and empty/echo results release their snapshots.

Keyboard and mouse scenarios delay real configuration replies across release, movement, long-hold recognition, combinations, shortcut changes, successive independent presses, and editor focus, including SELECT and Shadow DOM. Native key autorepeat after cancelling a press in an editor does not restart that cancelled interaction after focus leaves the editor. Valid short presses retain their own coordinates and commit once; cancelled presses do not resume. The fixture reserves paragraph space and checks the saved second pointer location so a preceding bilingual result cannot shift its target and obscure the input-state regression.

Tab-state and language scenarios delay real native storage acknowledgements and reads. Old enabled replies cannot restart stopped iframes; denied iframe starts do not translate; old navigation cleanup cannot erase the new session; old active-tab or popup language queries cannot overwrite a newer result. Popup translation waits for the top-frame manager's confirmed state and exposes a genuine missing-receiver failure after extension reload.

Popup/options bootstrap storage and locale failures show refresh recovery without resetting saved configuration. Failed settings saves roll back unconfirmed UI values, show feedback, and permit a later successful save. Provider addition keeps its dialog open on failure and does not leave a phantom provider. Failed rate/batch persistence sends no live queue mutation. Old theme/configuration reads cannot overwrite newer settings. Saved page shortcuts change or clear in the open page. Saved translation-mode changes restart an active session, including provider failure, retry, a second mode change, and source restoration.

Related ignored leaf promises in options opening, style preview, and cache-alarm initialization were also handled. Alarm listeners now register before initialization awaits. These particular failures were reviewed statically; they were not each fault-injected separately.

## Ablation and negative controls

Each experiment modified production source, rebuilt an extension, and loaded that build in the same real browser. Production bytes were restored after every experiment. Mutation patches, commands, source/build hashes, reports, screenshots, logs, and traces are under `.output/acceptance/lifecycle-audit-20261013/ablation/`.

| Experiment                                                                   | Observed result                                                         | Decision                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Restore the unused per-operation AbortController alongside the disposed flag | All 69 translation-only scenarios at the ablation checkpoint still pass | Remove the duplicate local cancellation state; retain document cancellation |
| Remove source-node identity comparisons while retaining HTML comparisons     | Identical-HTML node replacement retains the obsolete wrapper            | Retain node identity and DOM ownership checks                               |
| Remove the theme read-version comparison                                     | An old light-theme reply overwrites newer dark settings                 | Retain read freshness                                                       |
| Remove tab-operation identity checks                                         | Old navigation cleanup deletes the current enabled session              | Retain tab operation identity                                               |
| Restore the async wrapper around the config atom writer                      | Save rollback/recovery works, but the outer promise is unhandled        | Return the original handled task; retain rejection for awaiting callers     |

The config/provider atom wrappers were removed because they created additional promises without additional work. Document lifetime, source ownership, canonical snapshots, lock tokens, and persistent tab state remain. No retries or provider fallbacks were added.

## Reproduction and artifacts

Use the pinned pnpm 10.33.4. The checked commands are `pnpm type-check`, `pnpm lint`, and `pnpm build`; Chrome, Edge, Firefox, and sources packages were produced by `pnpm zip:all`. The existing hook checks passed without adding unit tests or reducing assertions; four existing fixtures were updated for accepted booleans, live browser metadata, and the new cancellation argument.

```sh
npx --yes pnpm@10.33.4 exec playwright install chromium
npx --yes pnpm@10.33.4 e2e:extension .output/chrome-mv3 .output/acceptance/bilingual
npx --yes pnpm@10.33.4 e2e:extension .output/chrome-mv3 .output/acceptance/translation-only --translation-only
```

Set `E2E_BROWSER_EXECUTABLE` to the Chrome for Testing executable to reproduce the recorded browser version. Run modes sequentially. `--case=<name>` selects a focused scenario, and an unknown scenario fails. The same complete suite runs in CI against the packaged Chrome directory.

Local baseline and fixed artifacts are in `.output/acceptance/lifecycle-audit-20261013/`. `packaged-final-summary.json`, per-mode `report.json`, `source-and-build.json`, `chrome-errors.json`, screenshots, metadata-only native API/message journals, and `trace.zip` record versions, environment, revision/status, source/script/build hashes, steps, and assertions. `package-verification.json` records ZIP versions and checksums; the Chrome ZIP payload matched the tested unpacked build byte for byte. Published assets are verified separately after merge. Immutable published 1.34.5 was used for the earlier red cases; the identical-HTML regression was additionally demonstrated against a frozen intermediate build before its correction.

## Evidence limits

The model endpoint is a local OpenAI-compatible HTTP fixture with success, delayed, failure, empty, and echo responses. Chrome APIs, handlers, worker reloads, and DOM remain real; timing/failure injection is at the external boundary and native calls are forwarded. Boot locale failure uses a controlled response from the extension's real locale fetch.

The native action popup driver attempts the documented [CDP Extensions.triggerAction](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-triggerAction) against the real tab target. Chrome did not expose its popup as a Playwright Page in these runs. The confirmation scenario therefore uses the real popup document with a declared tabs-query boundary selecting an actual fixture tab from Chrome's returned metadata. This limitation and every forwarded query are in `settings-boundaries.json`; native toolbar-window acceptance is not claimed. Other bootstrap/settings popup cases use the real popup document as a tab.

Playwright focus emulation prevents native hidden/visible and blur acceptance. The configuration-refresh scenario explicitly dispatches the public visibilitychange entry and tests real storage replies and events; it does not prove native tab activation. Authenticated X, production model services, and the user's everyday browser profile were not used. Edge and Firefox were build-checked, without runtime E2E. The supplied X screenshot alone cannot identify its script version or exact caller.
