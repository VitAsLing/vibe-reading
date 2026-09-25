# AGENTS.md

## Testing Notes

- Follow the global testing and acceptance policy. Project E2E flows run in the loaded browser extension. For complex feature changes, exercise the affected multi-step user workflow, including relevant page reloads, external-service failures, and recovery.
- For code changes, run `pnpm type-check`, `pnpm lint`, and `pnpm build`.
- Documentation-only changes require reference review and `git diff --check`; application tests and builds are not required.
