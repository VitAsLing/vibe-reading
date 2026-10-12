# Extension lifecycle acceptance — 1.34.5

The production unpacked extension was loaded in Chrome for Testing 155.0.8059.39 with a disposable profile. Bilingual and translation-only modes each passed 18 scenarios. Chrome's extension error collection was enabled, and both error lists were empty.

The scenarios cover a stopped background worker's first paragraph request, provider 401 and retry, mixed inline/block retries without disturbing neighboring translations, page shortcuts followed by paragraph gestures, dynamic paragraphs and SPA titles, in-flight and idle extension reloads, mounted error controls during reload, page reload recovery, late success/failure after stop or element reuse, old completion while a new request is pending, cancellation before preparation/insertion, and delayed language detection across A → B and A → B → A navigation.

## Ablation

Experiments changed production source, rebuilt it, and loaded each resulting extension in the same real browser. Each variant used the normal translation-only E2E entry point. Source and build hashes, mutation patches, commands, reports, screenshots, logs, and traces are retained under `.output/acceptance/review-20261013/ablation/`. Production source was restored after every experiment.

| Variant                                                                                                                                                          | Observed result                                                                                 | Decision                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Restore the unused manager interface, async queue factory, duplicate installation initialization, and duplicate validity check inside the managed timer callback | All 18 scenarios pass, as they do after deletion                                                | Delete these redundancies; WXT still checks validity before each retained timer tick |
| Remove the invalidation timer                                                                                                                                    | Idle reload leaves the old host mounted                                                         | Retain the timer                                                                     |
| Register queue listeners after awaiting initialization                                                                                                           | The first request after worker wakeup never translates                                          | Retain synchronous listeners awaiting shared readiness                               |
| Remove the language request version comparison                                                                                                                   | Late old A overwrites the new French A after A → B → A                                          | Retain request version and current-URL checks                                        |
| Remove session abort                                                                                                                                             | An obsolete request blocks translation in the reused SPA element                                | Retain cancellation                                                                  |
| Remove lock-owner comparison                                                                                                                                     | Old completion clears the pending new operation's lock; a duplicate gesture removes its spinner | Retain operation ownership                                                           |

The insertion-boundary regression was also demonstrated before its fix: stopping before a wrapper's animation-frame insertion left an obsolete snapshot, and the next translation restored the previous article. Captured source is now committed to restoration state only when a valid insertion actually runs. The corrected direct-text-owner scenario passes.

The Build workflow also removes a duplicate standalone build because WXT `zip` builds each browser target. Release ZIP versions are checked, and both E2E modes run against the Chrome directory that was packaged. Acceptance traces are uploaded separately from release ZIPs.

## Reproduction and evidence

Use the repository's pinned pnpm 10.33.4. The runtime checks are `pnpm type-check`, `pnpm lint`, and `pnpm build`. Install the default browser with `pnpm exec playwright install chromium`; set `E2E_BROWSER_EXECUTABLE` to a Chrome for Testing executable for the recorded browser version. Run the modes sequentially:

```sh
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/bilingual
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/translation-only --translation-only
```

Every run captures version, revision, working-tree state, source/script/build hashes before launch, data prerequisites, steps and assertions, real Chrome public-message records, fixture HTTP requests, worker stop/restart ordering, Chrome error collection, screenshots, and a Playwright trace. CI stores equivalent artifacts in the Build run's `extension-lifecycle` artifact.

The model endpoint is a local OpenAI-compatible HTTP fixture. Two cases delay a real Chrome message or animation-frame callback at the browser boundary before forwarding/resuming it. Extension functions, storage, worker lifecycle, and DOM are real. No daily browser profile or production credentials are imported.

Playwright's default focus emulation means this suite does not verify native tab hidden/visible changes. A separate attempt using raw Chrome and `connectOverCDP({ noDefaults: true })` timed out even without the extension or tracing; its results are retained as failed environment probes and are not counted as passing acceptance. An authenticated X page and a production model service were not tested. The supplied X screenshot does not reveal its script version or whether the page was refreshed after updating. Edge and Firefox are build-checked; this acceptance suite runs Chrome.
