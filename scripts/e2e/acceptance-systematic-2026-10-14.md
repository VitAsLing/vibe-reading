# Systematic asynchronous error acceptance — 1.34.10

This release consolidates the review of content tasks, background initialization and queues, cross-document configuration writes, and settings persistence acknowledgements. Earlier reload fixes are retained and tested again. Genuine provider, initialization and active-channel failures still surface; obsolete work cannot mutate a newer session or turn a failed save into success.

## Confirmed changes

| Boundary                       | Final observable behavior                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content task ownership         | Stop, source replacement and SPA navigation cancel pending preflight work before another request is sent. Idle DOM writes check ownership when they execute. Unwrapping with the already supplied configuration is synchronous, so it cannot invalidate its own in-flight operation.                                                    |
| Current page appearance        | A delayed translation cannot restore an older CSS snapshot after a newer style has been saved. Title and page-context completion check the current session, source and URL before updating state.                                                                                                                                       |
| Cold background initialization | A failed configuration or metadata read fails the current request. The next explicit request performs fresh initialization; a rejected readiness promise does not poison the worker permanently. No failed request is automatically replayed.                                                                                           |
| Queue and cache identity       | Queued, retried and batched requests retain the provider, model, prompt and context snapshot used for their identity. Changing settings while a request waits cannot execute it under a different model or mix incompatible batch snapshots.                                                                                            |
| Cross-origin navigation        | Reading translation state uses the live top tab URL scope. A new origin cannot inherit the previous origin's enabled session while asynchronous navigation cleanup is still pending.                                                                                                                                                    |
| Configuration persistence      | The synchronously registered background save handler serializes fresh read/merge/write across popup and options documents. Clients submit only changed ordinary fields. Whole provider and prompt collection replacements carry their observed base; an obsolete replacement fails explicitly and can be retried against current state. |
| Configuration confirmation     | Pending edits overlay confirmed state. An older save reply cannot overwrite a newer storage watch observation. Configuration and metadata are committed by one native storage operation; metadata failure cannot leave only half of the save committed.                                                                                 |
| Prompt import and dialogs      | Existing schemas validate imported prompt types before optimistic rendering. Import, edit and delete await persistence; failed drafts stay available and no success notification or dialog closure precedes the acknowledgement.                                                                                                        |
| Automatic editors              | Form submissions carry the original persistence promise through a small receipt. Failed JSON autosave stays retryable, and another edit can be submitted while an earlier persistence operation waits. CSS shows saved only after acknowledgement.                                                                                      |
| Provider deletion              | Provider removal and its fallback bindings are one configuration update. Failure preserves both the list and bindings.                                                                                                                                                                                                                  |
| Theme and locale               | Delayed failures or successes cannot revert newer confirmed theme state. Only the latest locale save completion may reload the page.                                                                                                                                                                                                    |
| Model suggestions              | An old credential's discovery response is discarded. Malformed model IDs are rejected before rendering, and a subsequent valid request recovers. API keys are not written to reports or used as plaintext cache keys.                                                                                                                   |

WXT storage 1.2.8 stores metadata at the physical `${key}$` key. The configuration save reads metadata before committing and uses `storage.setItems` for `local:config` and `local:config$` together. The loaded-extension atomicity case asserts the actual metadata key and forwarded native storage boundary. Recheck this contract if the pinned storage implementation changes.

## Final loaded-extension results

All four final runs loaded the same immutable production Chrome build in Chrome for Testing **155.0.8059.39**. Each ended with Chrome's extension error collection active and enabled, zero runtime errors, zero unexpected browser exceptions and zero diagnostic failures.

| Run directory              | Mode             | Visibility                                    | Passed checks |
| -------------------------- | ---------------- | --------------------------------------------- | ------------- |
| `full-bilingual-confirmed` | Bilingual        | Existing full-regression focus adapter        | 68            |
| `full-only-confirmed`      | Translation only | Existing full-regression focus adapter        | 71            |
| `native-bilingual`         | Bilingual        | Native foreground, background and frozen tabs | 39            |
| `native-only`              | Translation only | Native foreground, background and frozen tabs | 38            |
| Total                      |                  |                                               | **216**       |

Artifacts are under `.output/acceptance/consolidated-errors-20261013/`. `validation-summary.json` joins the four reports; each run records the command, version, source/build hashes, prerequisites, assertions, Chrome error collection, boundary records, trace and necessary snapshots/screenshots. The executing host SHA256 is:

`e3277e6462032dc10de3c33204db2942ae973ef20a9e0ca691a3923b6fd1e847`

The immutable build is `final-13410-chrome`. `local-package-proof.json` verifies that every one of the 41 Chrome ZIP payload files matches that build. Type checking, lint and Chrome/Edge/Firefox production packaging passed. Existing test fixtures retain their original behavior assertions and were adapted only for the current promise/checkpoint contracts; no unit test cases were added or deleted.

Four existing save-read fault cases now inject at the actual background native storage boundary rather than the obsolete document-local save path. They gate on the matching real `saveConfiguration` message and verify that exactly one forwarded read receives the failure, the plan is consumed, the caller receives the failure, and the original rollback/recovery assertions still hold. `save-boundary-migration` separately confirms these four cases plus the final empty error list. No original full-regression case was removed.

## Reproduction

Use the repository's pinned pnpm **10.33.4**, installed dependencies and an official Chrome/Chromium executable. `E2E_BROWSER_EXECUTABLE` selects the executable; otherwise the runner uses Playwright's installed Chromium. All browser launches use disposable fixture profiles with `--password-store=basic --use-mock-keychain`; no personal browser profile or keychain authorization is needed.

```sh
pnpm build
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/systematic/full-bilingual
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/systematic/full-only --translation-only
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/systematic/native-bilingual
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/systematic/native-only --translation-only
```

`scripts/e2e/native-cases.mjs` defines the native suite. It runs the earlier foreground/hidden/frozen reload and real-error visibility controls together with the new multi-step asynchronous failure/recovery cases. Native runs attach with `noDefaults: true` and assert real visibility and freeze transitions. The full-regression suite retains its declared focus emulation and popup-document adapter. CI repeats both modes of both suites and uploads its own reports and traces.

## Negative controls and scope

The published 1.34.9 build fails the new controls for cross-document field/collection saves, poisoned initialization, provider snapshot/cache identity, cross-origin session leakage, obsolete preflight/idle DOM work, outdated CSS completion, prompt persistence/type validation, theme and locale completion, JSON/CSS acknowledgement, provider deletion and model discovery. The malformed prompt-name control also records React error #31 in Chrome's extension error collection. Many other failures concern lost state or false success and need not produce a console exception.

Red reports/traces are preserved alongside the final runs, including `config-concurrency-red`, `provider-concurrency-red`, `background-startup-config-red-4`, `background-startup-metadata-red`, `background-request-snapshot-red`, `background-cross-origin-red`, `prompt-invalid-name-red`, `prompt-save-red`, `theme-all-failed-red`, `locale-late-ack-red`, `json-autosave-red-2`, `css-pending-ack-red`, `provider-delete-partial-red`, and `model-invalid-id-red`. Intermediate candidate controls `config-old-ack-red` and `config-atomic-core-red` fail without acknowledgement freshness and atomic metadata persistence respectively. Final cases include those failures and their next explicit recovery action. Exploratory selector/CDP plumbing failures are not product findings or passing evidence.

The obsolete asynchronous unwrap/config-read fallback was removed because both actual callers already supply configuration. Ownership, acknowledgement freshness, explicit collection conflicts, initialization recovery, atomic persistence and request snapshots were retained because the negative controls demonstrate observable failures without them. Existing reload validity controls continue to require genuine active-channel errors to be recorded; blanket suppression cannot pass acceptance.

The provider is a local OpenAI-compatible HTTP fixture. Delays and failures are injected at real native API or HTTP boundaries; extension code, Chrome storage/messages, workers and DOM are real. Authenticated X and production model services were not exercised. Edge and Firefox were packaged, but not runtime-tested. These checks establish the observed covered behavior and do not promise that unrelated network or future provider failures cannot occur.
