// Shared by the runner and CI. Native visibility has its own acceptance group;
// the original full regression suite keeps its declared focus adapter.
export function nativeAcceptanceCases(translationMode) {
  const cases = [
    "visible-pending-reload-recovery",
    "hidden-pending-reload-recovery",
    "hidden-frozen-page-reload-recovery",
    "live-channel-failure-stays-visible-and-recovers",
    "pending-error-hydration-survives-frozen-reload",
    "audit-provider-message-canonical",
    "audit-provider-message-embedded",
    "audit-rapid-reloads-pending-manual",
    "audit-disable-enable-pending-manual",
    "audit-bootstrap-resource-cancel-after-reload",
    "audit-pending-manager-receiver-reload",
    "settings-old-save-ack-preserves-newer-storage-watch",
    "settings-two-documents-preserve-concurrent-field-saves",
    "settings-two-documents-reject-stale-provider-replacement-and-recover",
    "settings-prompt-import-failed-save-has-no-success-and-recovers",
    "settings-prompt-import-rejects-name-object-before-ui-update",
    "settings-prompt-import-rejects-prompt-number-before-ui-update",
    "settings-configuration-metadata-failure-is-atomic-and-recovers",
    "content-idle-truncation-preserves-pending-translation",
    "content-idle-truncation-does-not-write-after-stop",
    "content-stop-cancels-pending-paragraph-preflight",
    "content-source-mutation-cancels-pending-paragraph-preflight",
    "content-route-cancels-pending-paragraph-preflight",
    "background-startup-config-read-failure-recovers",
    "background-startup-metadata-read-failure-recovers",
    "background-queued-provider-snapshot-preserves-cache-identity",
    "background-cross-origin-bootstrap-does-not-inherit-old-session",
    "ui-theme-old-failure-preserves-new-success",
    "ui-theme-all-failed-writes-restore-confirmed-theme",
    "ui-theme-old-success-ack-preserves-newer-confirmation",
    "ui-locale-late-save-confirmation-preserves-latest-choice",
    "ui-provider-json-failed-autosave-retains-retryable-draft",
    "ui-css-pending-save-is-not-acknowledged-and-failure-recovers",
    "ui-prompt-edit-failed-save-keeps-draft",
    "ui-provider-delete-failure-preserves-bindings-and-list",
    "ui-model-list-old-credential-response-is-discarded",
    "ui-invalid-model-list-response-is-rejected-and-recovers",
  ]
  if (translationMode === "bilingual")
    cases.push("content-obsolete-result-preserves-current-custom-css")
  return cases
}
