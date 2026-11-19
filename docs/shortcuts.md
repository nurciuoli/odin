# Keyboard shortcuts

`Mod` is `⌘` on macOS and `Ctrl` elsewhere; `Alt` is `⌥`. Press `?` anywhere in the app to see the same list. A
shortcut is skipped while you are typing in a field, unless noted.

## Everywhere

| Keys | What it does |
|---|---|
| `Mod+K` | Open the palette: search sessions, projects, files and commands |
| `Mod+Shift+O` | Start a new session in the background |
| `Mod+Alt+N` | New project |
| `?` | Show the keyboard shortcuts |
| `Ctrl+Shift+Space` | Open the launcher from any app (desktop app only; configurable in Settings) |

## Moving between sessions

| Keys | What it does |
|---|---|
| `Alt+↑` / `Alt+↓` | Previous or next session in the sidebar |
| `Mod+J` | Jump to the next session that needs you |
| `Mod+1` to `Mod+9` | Open the first to ninth session in the sidebar |
| `Alt+W` | On a new session: toggle running it in a fresh worktree |

## In a session

| Keys | What it does |
|---|---|
| `Mod+B` | Switch or sync the branch |
| `Alt+T` | Show the timeline of your messages. Move through it to scroll the conversation, `↵` stays, `Esc` goes back, `c` / `r` copy your message or Claude's reply |
| `Alt+/` | Ask a side question without interrupting the main thread |
| `Shift+Tab` | Change the permission mode |
| `Esc` | Pause the running turn |

## In the palette

Start with a prefix to narrow what it searches.

| Type | Searches |
|---|---|
| (nothing) | Sessions, projects, files and commands together, with recent items first |
| `>` | Commands only, such as new session on a given agent, switch model, open Library |
| `#` | Projects |
| `/` | Files |
| `@` | Branches and git actions (on a session screen): switch, create, stash, fetch, pull, push |

If nothing matches, the palette offers to start a new session from what you typed.

## In the message box

| Type | What it does |
|---|---|
| `/handoff` | Continue the session on another agent in the same folder and branch. `/handoff codex` goes straight there; add a model to pick one |
| `!command` | Run a shell command in the session's folder, for example `!git status`. The output goes to the agent with your next message |
| `/` | Show the available slash commands |
| `@` | Mention a file |

Hover one of your messages and press the rewind icon to open the rewind prompt. In it, `1` to `4` choose Branch,
Rewind, Files only or Fork chat, `↵` confirms and `Esc` cancels.
