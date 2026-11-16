# Security policy

Odin runs coding agents on your machine and holds tokens (an ingest token, optionally a GitHub token), so security
reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/nurciuoli/odin/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You should get a reply within
a week. Once a fix is released, the advisory is published with credit to you unless you'd rather stay anonymous.

## Scope

Odin is designed as a single-user, local application: core binds to `127.0.0.1`, checks Host and Origin, and
treats agent output and artifacts as untrusted. The full model is in
[docs/contracts.md](docs/contracts.md#security-model-single-user-local). Particularly relevant reports:

- a web page, artifact or agent output reaching Odin's API or the desktop shell's IPC;
- escaping the artifact sandbox or the filesystem confinement of project and session file operations;
- secrets reaching logs, API responses, events or agent processes;
- command injection through subprocess arguments.

Behaviour of the agent runtimes themselves (Claude Code, Codex and others) should be reported to their maintainers.

## Supported versions

Only the latest release receives security fixes.
