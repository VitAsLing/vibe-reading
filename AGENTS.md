# AGENTS.md

## Testing Notes

- Accept behavioral changes through repeatable E2E flows in the loaded browser extension. Cover the affected user flow and relevant failure states; record the browser/extension version, steps, assertions, evidence, and simulated external dependencies.
- Do not add unit tests or require the existing unit suite as an acceptance gate.
- For code changes, run `pnpm type-check`, `pnpm lint`, and `pnpm build`.
- Documentation-only changes require reference review and `git diff --check`; application tests and builds are not required.
