# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pitch is a TypeScript MCP server (stdio transport) that orchestrates local coding agent workspaces. It automates the setup of git worktrees, tmux windows/panes, and coding agent processes (Claude Code, Codex) from a GitHub issue number.

The project is being built according to the MVP issue sequence tracked in [GitHub Issues](https://github.com/rspurgeon/pitch/issues). `docs/design.md` is the authoritative source for architecture decisions, data schemas, and acceptance criteria.

## Prerequisites

- [mise](https://mise.jdx.dev/) — manages required tool versions (see `.mise.toml`)
- Run `mise install` to install the correct Node.js version

## Commands

A `Makefile` provides common developer tasks:

```bash
make install       # Install npm dependencies
make build         # Compile TypeScript to dist/
make clean         # Remove build artifacts
make start         # Launch the MCP server
make lint          # Type-check without emitting
make test          # Run unit tests (vitest)
```

## Tech Stack

- TypeScript (ESM, `"type": "module"`)
- `@modelcontextprotocol/sdk` — MCP server with stdio transport
- `zod` — schema validation (config + tool parameters)
- `yaml` — YAML parsing for config and workspace state files
- `tsx` — TypeScript execution without build step
- `vitest` — test framework
- Entry point: `src/index.ts`

## Important: stdio Protocol

The MCP server communicates over stdout via JSON-RPC. **Never use `console.log`** in server code — it corrupts the protocol stream. Use `console.error` (stderr) for any diagnostic output.

## Architecture

### Subsystem Layout

The codebase is organized around independent subsystems wired together by MCP tool handlers:

- **Config** — Loads `~/.pitch/config.yaml` at startup; typed interfaces for repos, agents, agent profiles
- **Workspace state** — YAML CRUD layer at `~/.pitch/workspaces/{name}.yaml`
- **Git** — Thin wrapper around `git worktree add/remove` shell commands
- **tmux** — Thin wrapper around `tmux` commands for session/window/pane management
- **Agent launcher** — Builds start/resume command arrays per agent type (Claude, Codex) and runtime (native, Docker via `agent-en-place`)
- **MCP tools** — Tool handlers that orchestrate the subsystems: `create_workspace`, `list_workspaces`, `get_workspace`, `resume_workspace`, `close_workspace`, `capture_session_id`

### Key Concepts

**Workspace identity:** A workspace is identified by its branch name, formatted as `gh-{issue}-{slug}` (e.g. `gh-565-fix-validation`). This same string is used as the git branch name, worktree directory name, and tmux window name.

**Agent launcher layering:** Agent commands are assembled from three sources in priority order: (1) agent defaults from config, (2) per-workspace overrides from `create_workspace` params, (3) hardcoded Pitch requirements (e.g. `--cd` for worktree path).

**Agent profiles:** A profile extends a base agent type with alternate env vars (e.g. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) to support multi-account usage. Profile resolution happens in the agent launcher before command building.

**tmux layout:** Each workspace window has a fixed three-pane layout — left tall pane for the coding agent, top-right and bottom-right empty shells for the user.

**Session IDs:** Claude session IDs are pre-generated (UUID) and passed at launch. Codex session IDs are discovered post-launch from pane output via `tmux capture-pane`.

### State Schema

Config: `~/.pitch/config.yaml`
Workspaces: `~/.pitch/workspaces/{workspace_name}.yaml`

See `docs/design.md` for the full YAML schemas for both files.

### External Dependencies

- `git` — worktree management
- `tmux` — window/pane orchestration
- `agent-en-place` — optional Docker runtime for agents
