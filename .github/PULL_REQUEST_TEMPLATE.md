<!--
Thanks for the pull request. Fill in the sections below and delete the ones that
do not apply. Keep the PR focused; smaller changes are easier to review and ship.
-->

## Summary

<!-- What does this PR do, and why? -->

## Related issues

<!-- e.g. Closes #123, Refs #456 -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (changes existing behavior or public API)
- [ ] New or updated adapter (provider integration)
- [ ] Documentation only
- [ ] Tooling / CI / internal

## Checklist

- [ ] `pnpm run check` passes locally (typecheck, lint, boundaries, tests).
- [ ] I added or updated tests covering the change.
- [ ] I added a changeset (`pnpm changeset`) for any user-facing change, or this change needs none.
- [ ] Public API changes are reflected in the docs and JSDoc.
- [ ] No secrets, API keys, or cardholder data appear in code, tests, or fixtures.

## For adapter changes

<!-- Delete this section if it does not apply. -->

- [ ] The adapter passes the shared conformance suite (`@payfanout/conformance`).
- [ ] The client/server boundary holds: no secret-bearing code in client packages (`pnpm run check:boundaries`).
- [ ] Adapter config requires an explicit `environment: "sandbox" | "live"`.
- [ ] Any pinned provider API version is stated in the adapter.

## For React / UI changes

<!-- Delete this section if it does not apply. Screenshots or a short clip help. -->

## Notes for reviewers

<!-- Trade-offs, follow-ups, or anything you specifically want feedback on. -->
