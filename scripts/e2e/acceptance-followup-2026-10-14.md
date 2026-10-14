# Async follow-up and bounded deletion acceptance — 1.34.12

This pass starts from main `d9d3e6e` / released 1.34.11. It checks configuration receipts, concurrent editors, background readiness and initial page-state replies. All reproduced defects below use the actual loaded extension and public user/system entrypoints.

## Reproduced defects and final behavior

| Boundary                                         | Failed control                                                                                                                                                                                                                                          | Final behavior                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repeated pending Reset                           | 1.34.11 sent an empty second patch; it closed the dialog after the first genuine save failed, with storage unchanged.                                                                                                                                   | An unchanged intent waits for its latest pending field owners and receives their original failure; deliberate retry persists defaults.                                                                             |
| Reset after another editor's update              | 1.34.11 left `translationOnly` saved after a completed Reset because its write-only document retained an older bilingual snapshot.                                                                                                                      | Reset subscribes to the existing configuration atom, so the default comparison includes observed changes from other editors.                                                                                       |
| Initial enabled-state reply after Stop           | 1.34.11 received its genuine held `true` reply after the reader started and stopped the new same-URL document. It enabled the tab again and sent one new HTTP translation request.                                                                      | The initial read captures the manager's existing session version. Only that unchanged session may apply its enabled result.                                                                                        |
| Late queue-setting save receipt                  | With document A's committed size 2 reply held, document B saved size 3. Real six-paragraph HTTP batches changed from `[3, 3]` to `[2, 2, 2]` when A's old reply arrived, while both UIs and storage stayed at 3.                                        | Configuration persistence and live queue changes complete in one background writer task. The UI no longer sends another queue mutation after receiving a save reply.                                               |
| Pending field queued back to its confirmed value | An initial 1.34.12 candidate matched only confirmed-to-optimistic differences. In a real same-document W1–W4 edit/reset sequence, the second Reset closed after the rate restoration failed; the saved rate stayed 9 instead of its observed default 8. | The repeated intent selects the latest pending owner of every submitted field, including values queued back to their prior confirmed value. Superseded owners and fields outside the submitted patch are excluded. |

`pending-reset-13411-confirmed`, `reset-two-documents-13411`, `bootstrap-read-13411-native`, `queue-old-ack-13411` and `pending-owner-before` are failed controls under `.output/acceptance/followup-review-20261014/`. The last uses the archived `pending-owner-before-chrome` candidate, not a published 1.34.12 package. Each report records its executing build hashes, exact command, native messages, storage/DOM observations and trace.

Configuration saves still derive nonempty patches from the optimistic previous value, preserving field isolation and avoiding replay of unrelated failed edits. Provider/prompt collection conflicts, hydration/storage-watch ownership and queue recovery remain.

For queue changes, the background validates `current → next`, waits for the existing queue instances, commits configuration and metadata in one native storage write, synchronously applies only the changed queue fields, then replies. Readiness failure occurs before the commit. Changing rate alone does not pass capacity and replenish tokens; changing batch settings does not overwrite an unrelated runtime request-queue setting. Existing public runtime queue setters remain available as system boundaries.

The cold-readiness E2E wakes a genuinely stopped worker through the native HTTP proxy while one completed native initialization metadata read fails. A real mode save recovers configuration initialization without touching queues. The first capacity save receives the original failed queue cohort and leaves both configuration and metadata unchanged; an independent capacity save and real paragraph gesture recover in the same worker.

## Removed code and deletion experiment

Removed the unused proxy session-cache group/registry, its TTL, background cache branches and `cacheConfig` protocol field. The sole production `backgroundFetch` caller does not enable that cache. Its native GET/base64 path, text response conversion, Blob request deduplication and failure cleanup remain.

Also removed uncalled language-list helpers, two provider-config predicate wrappers, a language-detection wrapper, unused range/provider item constants, and the commented obsolete configuration-atom implementation. Active schemas, provider items, language detection, lifecycle guards and meaningful test cleanup seams remain.

Application source decreases by **335 lines**, including the fixes. Three obsolete `cacheConfig: undefined` fixture properties were removed before deleting the production field. No unit cases were added or deleted. Six real multi-step E2E scenarios were added; existing save failure, metadata atomicity, UI recovery and runtime behavior assertions remain. Queue tests now await the public save receipt rather than the removed UI's second message; real HTTP batch behavior supplies the live-queue acceptance.

The proxy deletion control runs the production public protocol through native extension messaging and background HTTP: two binary GETs, a 503, a recovered GET and a Unicode POST. Before and final-after requests and response payloads compare equal except the server's naturally changing HTTP `Date` header. Error collection is enabled and empty in both. `proxy-preservation.mjs`, `proxy-before`, `proxy-final` and `proxy-removal-equivalence.json` are retained in the artifact directory; this control does not claim a provider-icon UI test.

## Loaded-extension acceptance

All four final runs load the same immutable production build in Chrome for Testing **155.0.8059.39**:

| Run                | Mode             | Visibility                             |  Passed |
| ------------------ | ---------------- | -------------------------------------- | ------: |
| `full-bilingual`   | Bilingual        | Existing full-regression focus adapter |      69 |
| `full-only`        | Translation only | Existing full-regression focus adapter |      72 |
| `native-bilingual` | Bilingual        | Native foreground/background/frozen    |      46 |
| `native-only`      | Translation only | Native foreground/background/frozen    |      45 |
| Total              |                  |                                        | **232** |

Every final run has Chrome's runtime-error collector active and enabled, zero runtime errors, zero unexpected browser exceptions and no diagnostic failures. `validation-summary.json` joins the final reports. Artifacts include commands, prerequisites, source/build fingerprints, native records, screenshots and traces. CI runs the same four groups.

Host SHA256: `5ef10df4fd690fd1b72df494b72621cdfaec2181c1820c43b0b007d694703b9d`.

Background SHA256: `f012b0409b905ed3065e6e40988e51440b89398dbb07ca75461e05128a9d8857`.

```sh
pnpm build
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/followup/full-bilingual
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/followup/full-only --translation-only
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/followup/native-bilingual
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/followup/native-only --translation-only
```

Use pinned pnpm **10.33.4**. `E2E_BROWSER_EXECUTABLE` selects an official Chrome/Chromium executable. All launches use disposable profiles with `--password-store=basic --use-mock-keychain`; no personal browser profile, credential store or keychain is used. Native runs attach without focus overrides.

The initial-state scenario installs its reply boundary through genuine navigation and isolated-world script execution before the normal host entrypoint. Only the fixture's parser-blocking external script waits for installation, then returns empty JavaScript. That fixture gate and its listener are removed before user interaction. The production package/manifest are unchanged by the test, and the held enabled reply is forwarded before it is delayed. Two earlier debugger-installation attempts and the first pending-reset setup attempt failed in the test apparatus; they are excluded from defect evidence and final counts.

Models use a loopback OpenAI-compatible HTTP fixture. Delays and failures occur at native Chrome message/storage or HTTP boundaries; Chrome storage, workers, script execution, configuration UI and DOM are real. Authenticated X, production model services, Edge/Firefox runtime and the daily browser's current error history were not inspected.
