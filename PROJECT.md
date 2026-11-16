---
name: odin
title: Odin
description: A harness-agnostic Agentic Development Environment. A bird's-eye view of every coding agent, with a shared library.
repo: nurciuoli/odin
default_branch: main
commands:
  install: yarn install
  check: yarn typecheck && yarn test
  build: yarn build:web
---

Odin's project manifest, read by Odin itself when this repository is registered as a project. See
[README.md](README.md) for what Odin is and [docs/overview.md](docs/overview.md) for the design.
