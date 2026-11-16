# Contributing to Odin

Thanks for your interest. Bug reports, fixes, docs improvements and new harness drivers are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach.
- Read [AGENTS.md](AGENTS.md). It is the short version of the project's rules, written for coding agents, and it
  applies to human contributors too.
- [docs/development.md](docs/development.md) covers setup, running and testing.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests next to the code (`*.test.ts`).
3. Run the checks:
   ```sh
   yarn typecheck
   yarn test
   yarn verify:web   # if you touched packages/web
   ```
4. Open a pull request describing what changed and why, and how you tested it.

## Ground rules

- **Yarn 4 only.** Never run `npm install` or commit a `package-lock.json`.
- **Contract changes go in their own commit** and are called out in the PR: anything in `packages/shared/`,
  `packages/core/src/services.ts`, `packages/core/src/harness/types.ts`, `docs/contracts.md`, the database schema
  or migrations, and `packages/web/src/api/types.ts`.
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
