# Code and test ablation acceptance — 1.34.11

The simplification starts from clean main `7ca4bf6` / 1.34.10. It removes uncalled production code and checks that never exercised current product behavior, preserves the demonstrated lifecycle/persistence boundaries, and repairs a same-URL iframe document identity defect discovered while flattening its injector.

## Removed and flattened code

- Removed the unused multilingual dictionary-label table, unused schemas and general helpers. Explicit named consumers and dynamic import paths were checked; the language-code lists, locale labels and active schemas remain.
- Removed uninitialized Iconify transport, unused style observers, orphan UI components and four unused DOM predicates. Current SVG assets, toast styles, DOM classification, rAF batching and meaningful DOM fixture flushes remain.
- Removed ten obsolete background/config/provider APIs and the test-only generic provider update API. Existing provider/header/options/schema assertions now exercise the live LLM helper. Privacy assertions verify the serialized export directly instead of calling another unused production helper with the same traversal algorithm.
- Flattened model recommendations into the existing ordered table. Catalog, regexes, flags, option payloads and match indexes compare equal before/after; SDK option types and user overrides remain.
- Reduced the iframe injector to its one actual host script. Pending work, frame/document identity, navigation/tab cleanup, failure handling and Kiwix policy remain.
- Removed unused extension-version initialization, including its unnecessary top-level manifest read.

Application source decreases by **2,925 lines**. Existing test/scaffolding code decreases by 159 lines. E2E source increases by 153 lines after removing obsolete save adapters and adding one real multi-step iframe case. The net source/test/script reduction is **2,931 lines**, excluding this acceptance report. The built Chrome payload is about 3.8 KB smaller; most removed code was already tree-shaken, so the principal benefit is maintenance, not a large download or latency improvement.

## Test cleanup and preserved coverage

Seven low-value unit cases were removed: two source-spelling popup checks, three tests of an uninitialized Iconify transport, a third-party private-method existence check, and a test that only called its own translation stub. The remaining **71 test files / 564 cases** passed without the global console suppression or manual TextEncoder shim. That shim truncated Chinese UTF-16 code units into bytes: `你好` produced two incorrect bytes; native UTF-8 produces the required six. `encoder-ablation.json` records both outputs.

No new unit cases were added. Queue ordering, deduplication, rate limits, retry, recovery, schemas, credential removal and the real DOM matrix remain. Page-shortcut and inactive/same-mode control tests also remain because corresponding native negative boundaries are not fully covered by current E2E. Two CI exclusions for a nonexistent free-api test were removed.

Configuration E2E faults now require the current `saveConfiguration` message and exactly one forwarded/settled native background read. Removed document-local legacy branches no longer let a current regression silently exercise the wrong save path. All previous E2E cases and failure/recovery assertions remain. Historical old-package controls can be reproduced with their frozen original runner and archived build.

## Deletion controls and iframe defect

Two temporary production deletion controls ran in the actual loaded extension, then were restored automatically:

| Control                                         | Observed failure                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Disable paragraph preflight checkpoint          | The stopped operation sent one new provider request instead of zero. |
| Disable configuration acknowledgement ownership | An old successful reply overwrote newer confirmed UI state.          |

These mechanisms remain. Reports, traces, executing source hashes and ablation patches are under `without-page-checkpoint` and `without-config-confirmation-owner`; `negative-controls.json` joins their evidence. Dead-code deletion has a different expected result: its absence preserves behavior and does not require an artificial failing control.

The iframe probe first performs a real paragraph gesture, holds a successful native script reply only after actual execution, reloads the iframe at the identical URL while page translation is off, releases the old reply, confirms the existing once-only paragraph scan, then enables page translation with the real shortcut. Both the released 1.34.10 build and the initial simplified candidate wrongly forwarded one host injection instead of two. Chrome's genuine frame snapshots and script results supplied different document IDs, but the bulk scan discarded them and reused the old URL cache key.

The fix passes the optional frame `documentId` through the existing target/identity path. The existing URL fallback remains for APIs that omit it. Final acceptance checks a second genuine host execution in the current document, the real child runtime flag, and one translated child paragraph. `iframe-same-url-13410` and `iframe-same-url-before` are failed controls; each final run records `iframe-simplification.json` with native arguments, results, IDs and forwarded counts. This is one added E2E scenario, exercised in both modes and visibility environments.

## Final loaded-extension acceptance

All four runs loaded the same immutable production build in Chrome for Testing **155.0.8059.39**:

| Run                | Mode             | Visibility                             | Passed  |
| ------------------ | ---------------- | -------------------------------------- | ------- |
| `full-bilingual`   | Bilingual        | Existing full-regression focus adapter | 69      |
| `full-only`        | Translation only | Existing full-regression focus adapter | 72      |
| `native-bilingual` | Bilingual        | Native foreground/background/frozen    | 40      |
| `native-only`      | Translation only | Native foreground/background/frozen    | 39      |
| Total              |                  |                                        | **220** |

Each ends with Chrome's error collector active and enabled, no runtime errors, no unexpected browser exceptions and no diagnostic failures. Artifacts are under `.output/acceptance/ablation-cleanup-20261014/`; reports include commands, prerequisites, versions, source/build hashes, assertions, native records, screenshots and traces. `validation-summary.json` joins the final reports.

Host SHA256: `e00ed79e37ee4cf2c7ff83abd2c71d154b66276c28a6ad7babd2d10fbb95013e`.

Background SHA256: `b213b62f6134ceda89e9aae0f9ddc52550f1c560390a00cd9d244657b2d3a506`.

```sh
pnpm build
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/ablation/full-bilingual
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/ablation/full-only --translation-only
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/ablation/native-bilingual
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/ablation/native-only --translation-only
```

Use pinned pnpm 10.33.4. `E2E_BROWSER_EXECUTABLE` can select an official Chrome/Chromium executable. All launches use disposable profiles with `--password-store=basic --use-mock-keychain`; native runs attach with `noDefaults: true`. CI repeats the four groups and uploads its own artifacts.

The provider is a local OpenAI-compatible HTTP fixture; delays/failures occur at native API or HTTP boundaries. Chrome storage, messages, script execution, workers and DOM are real. Authenticated X, production model services and Edge/Firefox runtime were not exercised. The iframe probe covers an ordinary origin and its real documents; Kiwix allow/deny policy remains covered by existing isolated behavioral tests, rather than a claimed live Kiwix acceptance.
