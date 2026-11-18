---
name: odin-pr
description: Ship a change in the Odin repo as a pull request - branch, checks, Conventional Commit title, PR template, contract label and CHANGELOG line. Use when opening or preparing a PR for Odin.
---

# Open an Odin pull request

Follow these steps in order. AGENTS.md and CONTRIBUTING.md are the source of truth; this is the checklist.

## 1. Branch

- Work on a branch from an up-to-date `main` named `type/short-desc` (`feat/`, `fix/`, `docs/`, `chore/`, `refactor/`,
  `test/`, `perf/`, `build/`, `ci/`), e.g. `fix/windows-short-paths`.
- If you were given a generated branch (`claude/...`, a worktree name), create a `type/short-desc` branch at your
  commits and open the PR from that one.

## 2. Checks

Run from the repo root (`corepack yarn` if `yarn --version` prints 1.x; `yarn install` first in a fresh checkout):

```sh
yarn typecheck
yarn test
yarn verify:web   # only if packages/web changed; run `yarn workspace @odin/web format` first
```

All must pass. If something fails, fix it and re-run only what failed; never skip or disable a test.

For web changes, screenshot the affected screens on mock data (`yarn dev:web`, then
`yarn workspace @odin/web shots <route>`), look at them, and attach them to the PR. Don't update the README images in
`docs/assets/screenshots/` unless asked.

## 3. Contract check

List changed files: `git diff --name-only origin/main...HEAD`. Any of these is a contract change:

- `packages/shared/**`
- `packages/core/src/services.ts`
- `packages/core/src/harness/types.ts`
- `docs/contracts.md`
- `packages/core/src/db/schema.sql` or migrations
- `packages/web/src/api/types.ts`

If any match: list them and what changed in the PR's **Contract changes** section, add the `contract` label, and
update `docs/contracts.md` if behaviour changed. A breaking change gets `!` in the title and an explanation in the
body. A large contract change should be its own PR, landed first.

## 4. CHANGELOG

For any user-visible change, add one line under `## [Unreleased]` in `CHANGELOG.md`, written for users (what changed,
not how). Internal-only changes (tests, refactors, CI, agent tooling) need no entry.

## 5. Title

Conventional Commits, checked by CI: `type(scope): imperative summary`.

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes (optional): `core`, `web`, `shared`, `desktop`, `adapter`, `library`, `harness`, `deps`. Leave it out when
  the change spans several or none.
- Must match `^(type)(\((scope)\))?!?: [^ ].{2,}$`. The title becomes the squash commit on `main`.

## 6. Body and open

Fill in `.github/pull_request_template.md`: **What and why** (link the issue), **How it was tested** (commands run,
manual checks, screenshots), **Contract changes** (`None.` or the list from step 3), and tick the **Checklist**.
State the reason for any new runtime dependency.

Open the PR against `main`, ready for review (not a draft). One concern per PR.
