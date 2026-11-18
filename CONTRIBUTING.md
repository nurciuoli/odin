# Contributing to Odin

Thanks for your interest. Bug reports, fixes, docs improvements and new harness drivers are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Read [AGENTS.md](AGENTS.md). It is the short version of the project's rules, written for coding agents, and it
  applies to human contributors too.
- [docs/development.md](docs/development.md) covers setup, running and testing.

## Making a change

1. Create a branch from an up-to-date `main`: in your fork, or in this repository if you have write access. Name it
   `type/short-desc` using the types below, e.g. `fix/windows-short-paths` or `feat/notebook-files`. Rename
   auto-generated branch names (agent worktrees and the like) before opening the PR.
2. Make your change, with tests next to the code (`*.test.ts`). Commit however you like on the branch: it is
   squashed on merge.
3. For any user-visible change add a fragment file `changes/<type>-<short-desc>.md` with the entry as a list item (see
   [changes/README.md](changes/README.md)). Don't edit [CHANGELOG.md](CHANGELOG.md) in the PR: fragments can't conflict.
4. Run the checks:
   ```sh
   yarn typecheck
   yarn test
   yarn verify:web   # if you touched packages/web
   ```
5. Open a pull request against `main` using the template. Draft PRs are welcome for early feedback.

## Pull requests

`main` is protected: every change lands through a PR with green CI (core and web on Ubuntu, plus the PR title
check). PRs are **squash-merged**, so one PR is one commit on `main` and the merged branch is deleted.

**The PR title becomes that commit**, so it follows [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): summary in the imperative
```

- **type:** `feat` (user-visible feature), `fix` (bug fix), `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
  `chore`, `revert`.
- **scope** (optional): `core`, `web`, `shared`, `desktop`, `adapter`, `library`, `harness`, `deps`.
- Add `!` before the colon for a breaking change (`feat(shared)!: ...`) and explain it in the PR body.

Examples: `fix(core): expand Windows 8.3 short paths when matching worktrees`,
`feat(web): open notebooks from the Files tab`, `docs: describe the contribution process`.

Keep each PR to one concern. If it needs a contract change and that change is large, land the contract first as its
own PR.

### Contract changes

These files are contracts between modules: `packages/shared/`, `packages/core/src/services.ts`,
`packages/core/src/harness/types.ts`, `docs/contracts.md`, the database schema or migrations, and
`packages/web/src/api/types.ts`. A PR that touches any of them lists them in the template's **Contract changes**
section, gets the `contract` label, and updates `docs/contracts.md` if behaviour changed.

## Releases

Versions follow [Semantic Versioning](https://semver.org/). To release, run `yarn changelog:release X.Y.Z` in a
`chore: release vX.Y.Z` PR (it moves the `changes/` fragments and any Unreleased entries under a new version heading
in CHANGELOG.md), then tag the merge commit `vX.Y.Z`.

## Ground rules

- **Yarn 4 only.** Never run `npm install` or commit a `package-lock.json`.
- **Contract changes are called out** in the PR (see [Contract changes](#contract-changes)).
- **Few dependencies.** Core has no web framework. A new runtime dependency needs a reason in the PR.
- **No real side effects in tests:** no network, no real `~/.odin` or `~/.claude`, no real GitHub, no model calls.
- **Security rules hold everywhere:** secrets never reach logs, responses, events or agent processes; subprocesses
  use argv, never a shell string built from input; artifacts render only in sandboxed frames. See the security
  model in [docs/contracts.md](docs/contracts.md#security-model-single-user-local).
- **Web code** follows the Instrument UI rules in AGENTS.md: build from library components, design tokens only, and
  accessible by default.

Using a coding agent to help is fine. You are responsible for reviewing and understanding everything you submit.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
