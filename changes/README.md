# Changelog fragments

Each pull request with a user-visible change adds one file here instead of editing `CHANGELOG.md`, so PRs never
conflict on the changelog.

- Name it after the branch: `changes/<type>-<short-desc>.md` (e.g. `changes/fix-windows-short-paths.md`).
- Put the entry in it as one or more Markdown list items, written for users (what changed, not how):

  ```md
  - Sessions started in a terminal take the harness's generated name instead of staying "Untitled session".
  ```

- `yarn changelog:check` validates the fragments (CI runs it).
- A release PR (`chore: release vX.Y.Z`) runs `yarn changelog:release X.Y.Z`, which moves every fragment, in file
  name order, under a new version heading in `CHANGELOG.md` and deletes them.
