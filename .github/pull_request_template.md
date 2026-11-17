<!-- Title: Conventional Commits, e.g. `fix(core): expand Windows short paths`. It becomes the squash commit on main. -->

## What and why

<!-- What this changes and the reason for it. Link the issue if there is one (Closes #123). -->

## How it was tested

<!-- Commands run, and anything checked by hand. -->

## Contract changes

<!-- None, or list the contract files touched (packages/shared/, services.ts, harness/types.ts, docs/contracts.md,
schema/migrations, web/src/api/types.ts) and what changed. Add the `contract` label. -->

None.

## Checklist

- [ ] `yarn typecheck` and `yarn test` pass
- [ ] `yarn verify:web` passes (if `packages/web` changed)
- [ ] CHANGELOG.md updated under Unreleased (if user-visible)
- [ ] Docs updated if behaviour changed
