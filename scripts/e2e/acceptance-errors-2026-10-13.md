# Error boundary acceptance — 1.34.9

Two failures were reproduced in the published 1.34.8 Chrome payload. A provider's HTTP error containing `Extension context invalidated` disposed an otherwise valid content script, removing successful translations and Retry controls. A locale request rejected after an actual extension reload left an unhandled `TypeError: Failed to fetch` from the already invalidated bootstrap.

The lifecycle classifier now accepts only a plain `Error` with the complete native invalidation message. The SDK's `AI_APICallError` retains normal provider failure and Retry behavior, even when its message matches Chrome's wording. Bootstrap failures finish quietly if their context is already invalid; failures in a still-valid bootstrap remain visible. The existing bounded channel-error reporting and lifecycle cleanup remain unchanged.

## Evidence

Chrome for Testing 155.0.8059.39 loaded the production unpacked 1.34.9 extension in disposable profiles. All launches use `--password-store=basic --use-mock-keychain`; no personal profile or keychain authorization is required. The executing host source and packaged host share SHA256:

`afdf3e06639d47011efae38a95853bf2cc917109ab6caafcb71f6702e9c47bfd`

The complete regression reports under `.output/acceptance/recheck-1348-20261013/` passed all 163 checks:

| Report directory   | Checks | Result |
| ------------------ | -----: | ------ |
| `full-bilingual`   |     68 | Passed |
| `full-only`        |     71 | Passed |
| `native-bilingual` |     12 | Passed |
| `native-only`      |     12 | Passed |

Both native runs retain the five earlier reload scenarios and add these six scenarios. Native runs do not override focus or visibility; the original full regression suite retains its declared focus emulation and popup-document adapter.

- `audit-provider-message-canonical` and `audit-provider-message-embedded`: translate a neighboring paragraph, return a real local HTTP 401 with the selected wording, and assert that the exact target reply is `AI_APICallError` with that original message. The native runtime stays live, the neighbor remains translated, Retry remains available, and a real Retry succeeds after HTTP recovery. The two cases were repeated after strengthening the exact reply assertions: `strengthened-bilingual` and `strengthened-only` each passed seven checks including Chrome's final empty error-list check.
- `audit-rapid-reloads-pending-manual`: hold an actual manual translation HTTP request, reload the extension twice, release the obsolete response, then refresh and complete a new translation. Obsolete UI stays disposed.
- `audit-disable-enable-pending-manual`: use Chrome's actual management API to disable and enable the fixture extension with a manual request pending. Its late response cannot mount obsolete error controls; refreshing restores translation.
- `audit-bootstrap-resource-cancel-after-reload`: hold the native extension locale request, reload, assert the old bootstrap's injected flag is false, then abort the resource. No unhandled rejection appears; refreshing mounts a new host. This covers a failure after confirmed invalidation, not a resource failure preceding delayed native binding invalidation.
- `audit-pending-manager-receiver-reload`: click Translate in the real popup document with its actual host tab selected through a declared native tabs-query boundary. Hold the real session-state reply, reload, and verify the disposed receiver creates no unhandled rejection. Refresh and the page shortcut recover translation. Reload also terminates the old worker and popup; this does not prove a sender remaining alive while only its receiver is destroyed.

Reports contain commands, environment and data prerequisites, revision/diff and source/build hashes, browser diagnostics, native message/storage records, HTTP requests, screenshots, and Playwright traces. Chrome's error collection is active and empty in all passing reports. Type checking, lint, and Chrome/Edge/Firefox production packaging passed; Edge and Firefox were not runtime-tested.

## Reproduction

Use the pinned pnpm 10.33.4. `E2E_BROWSER_EXECUTABLE` may select an installed official Chrome/Chromium executable; otherwise the installed Playwright Chromium is used.

```sh
pnpm build
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/full-bilingual
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/full-only --translation-only
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-bilingual --case=visible-pending-reload-recovery,hidden-pending-reload-recovery,hidden-frozen-page-reload-recovery,live-channel-failure-stays-visible-and-recovers,pending-error-hydration-survives-frozen-reload,audit-provider-message-canonical,audit-provider-message-embedded,audit-rapid-reloads-pending-manual,audit-disable-enable-pending-manual,audit-bootstrap-resource-cancel-after-reload,audit-pending-manager-receiver-reload
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-only --translation-only --case=visible-pending-reload-recovery,hidden-pending-reload-recovery,hidden-frozen-page-reload-recovery,live-channel-failure-stays-visible-and-recovers,pending-error-hydration-survives-frozen-reload,audit-provider-message-canonical,audit-provider-message-embedded,audit-rapid-reloads-pending-manual,audit-disable-enable-pending-manual,audit-bootstrap-resource-cancel-after-reload,audit-pending-manager-receiver-reload
```

## Controls and limits

The immutable official 1.34.8 payload fails `provider-canonical`, `provider-embedded`, and `bootstrap-cancel`; the reports record its host SHA256 `8683ed372a1ffd3ae4c0b90385ff919c0ae8038e3ebfb35adb34aed8586befd2`. Repeated reloads, disable/enable, and pending receiver reload passed on 1.34.8, so those paths did not justify additional production changes.

The `live-bootstrap-control` report intentionally fails: a copied harness omits the extension reload, asserts that the held locale request belongs to a still-live bootstrap, and aborts that request. Version 1.34.9 still emits the expected `TypeError: Failed to fetch`. This negative control demonstrates that the invalid-context guard does not suppress a genuine live bootstrap failure. It is not a passing regression run. The copied harness and trace are retained under `live-bootstrap-control-harness` and `live-bootstrap-control`; production source was not changed for this control.

The provider is a local OpenAI-compatible HTTP fixture. Fault injection is at HTTP, Chrome reply, or extension resource boundaries; actual extension code, messaging, storage, worker lifecycle, and DOM run in Chrome. Authenticated X and production model services were not exercised. The results establish the specified failures and recovery paths, not the absence of every possible extension error.
