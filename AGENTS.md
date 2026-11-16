# Working on Odin

Read by anyone working in this repo: contributors, and coding agents (including ones Odin starts). See also
[CONTRIBUTING.md](CONTRIBUTING.md).

## Start here

- `docs/overview.md`: what Odin is and the decisions behind it. `docs/architecture.md`: how the pieces fit.
- `docs/development.md`: setup, running, checks and environment variables.
- `docs/contracts.md`: API, SSE, harness, library, ingest, sync and security rules. `packages/shared/src/` holds the
  types and is the source of truth; `packages/core/src/services.ts` holds the seams between core modules and
  `packages/core/src/harness/types.ts` the harness interface.
- `docs/desktop.md`: the Electron shell.
- `CHANGELOG.md`: add a line under Unreleased for any user-visible change.

## Layout

- `packages/shared`: types and small helpers (sessions, harness events and the transcript reducer, library rules,
  labels, pricing, agent files).
- `packages/core`: the server. `node:http`, `node:sqlite`, SSE, agent sessions through harness drivers. One folder
  per module (`projects`, `sessions`, `launch`, `library`, `artifacts`, `sync`, `ingest`, `metrics`,
  `settings`, `tracking`), each with `service.ts` (implements an interface from `services.ts`) and `routes.ts`.
  `harness/` holds the `Harness` interface (`types.ts`), the scriptable fake driver (`fake.ts`) and the Claude driver
  (`claude/`, the only code allowed to import `@anthropic-ai/claude-agent-sdk`).
- `packages/web`: Vue 3.5 app. `src/components`, `src/styles`, `src/composables` are **Instrument UI**, a vendored design system
  (see NOTICE; plus Odin's additions: permission prompt, tool call, terminal output); `src/screens` and
  `src/app` are Odin's; `src/api` is the client (`types.ts` is the contract, `http.ts` real, `mock.ts` fixtures).
- `apps/desktop`: the Electron shell (wave 3). The web app must keep working in a plain browser.
- `adapters/claude-code`: hooks that report terminal Claude Code sessions to Odin's ingest API.
- `templates/library`: seed content copied into an empty `~/.odin/library/` on first boot.

## Rules

- `yarn typecheck` and `yarn test` must pass before you call something done. `yarn verify:web` if you touched web.
- Yarn 4 (Corepack), not npm: never run `npm install` or commit a `package-lock.json`. Add deps with
  `yarn workspace <name> add`. A fresh worktree needs `yarn install`. If `yarn --version` is 1.x, use `corepack yarn`.
- Node 24 runs TypeScript directly: erasable syntax only (no enums, namespaces or parameter properties); imports use `.ts`.
- Core has no web framework and few deps. A new runtime dependency needs a reason in the PR.
- Contract changes (`packages/shared/`, `services.ts`, `harness/types.ts`, `docs/contracts.md`,
  `db/schema.sql`/migrations, `web/src/api/types.ts`) go in their own commit and are called out in the PR.
- Keep changes scoped to the task. Need a contract change? Say so in your report or PR.
- Tests next to the code (`*.test.ts`): `node:test` in core/shared/adapters, vitest in web. No network, no real
  `~/.odin` or `~/.claude`, no real GitHub, no real model calls: use `testDeps()` / `startApp()` from
  `packages/core/src/test-helpers.ts`, `fakeHarness()` from `packages/core/src/harness/fake.ts`, and fakes.
- Secrets (GitHub token, ingest token) never reach logs, responses, events or agent processes. Model credentials are
  the environment's: Odin never reads or stores them.
- Subprocesses via `execFile`/`spawn` with argv, never a shell string built from input.

## Web (Instrument UI rules, short form)

- `<script setup lang="ts">`, `withDefaults(defineProps<…>())`, `defineModel`, tuple `defineEmits`.
- Build screens from the library (`@/components/<Name>` barrels). Don't restyle library internals (`.iu-foo__bar`)
  from a screen: ask for a prop/variant. Tokens only: no hex/rgb, raw font stacks, or raw type sizes/weights.
- Statuses use `@/styles/status` (`Status`, `statusIntent`, `statusLabel`). Never colour-only.
- Real `<button>`s, `aria-*` on live regions and toggles, `:focus-visible` outlines, `prefers-reduced-motion`.
- Never move focus to content that appears on its own (streamed replies, new tool calls, session activity).
- Prettier formats web (`yarn workspace @odin/web format`). `yarn verify:web` runs format check, type-check,
  ESLint, the guard, vitest and a strict build.
- Artifacts render only in `<iframe sandbox="allow-scripts allow-forms" src="/a/…">`. Never `srcdoc`, never
  `allow-same-origin`, never `v-html`.
