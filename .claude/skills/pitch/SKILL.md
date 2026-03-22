---
name: pitch
description: Invoke Pitch MCP server tools to manage coding agent workspaces. Use this skill whenever the user runs /pitch or asks to create, list, get, resume, or close a workspace, or wants to ping the Pitch server. This is the primary interface for orchestrating git worktrees, tmux windows, and coding agent sessions from GitHub issues.
---

# Pitch — Workspace Orchestration

This skill parses `/pitch` arguments and calls the corresponding Pitch MCP tool.

## Argument Format

```
/pitch [subcommand] [positional args] [--flags]
```

**Default behavior:** If the first argument is a number (issue number), `create` is implied. This means `/pitch 565 fix-validation` is equivalent to `/pitch create 565 fix-validation`.

## Subcommands

### `create` (default) — Create a new workspace

```
/pitch <issue> <slug> [--agent <agent>] [--model <model>] [--repo <org/repo>] [--base-branch <branch>] [--runtime <native|docker>]
/pitch create <issue> <slug> [--flags]
```

- `issue` (required) — GitHub issue number (integer)
- `slug` (required) — descriptive text for branch naming (e.g. `fix-validation`)
- `--agent` — agent type or profile name (e.g. `claude`, `codex`, `claude-personal`)
- `--model` — model override for this workspace
- `--repo` — GitHub org/repo (e.g. `kong/kongctl`)
- `--base-branch` — branch to create from (defaults to `main`)
- `--runtime` — `native` or `docker`

Call `mcp__pitch__create_workspace` with the parsed parameters:
- `issue` → number
- `slug` → string
- `repo`, `base_branch`, `agent`, `runtime`, `model` → string (only include if provided)

**Examples:**
- `/pitch 565 fix-validation` (shortest form)
- `/pitch 565 fix-validation --agent claude --model opus`
- `/pitch create 565 fix-validation --agent claude`

### `list` — List workspaces

```
/pitch list [--status <active|closed|all>] [--repo <org/repo>]
```

Call `mcp__pitch__list_workspaces` with:
- `status` → string (only if provided)
- `repo` → string (only if provided)

**Example:** `/pitch list --status active`

### `get` — Get workspace details

```
/pitch get <name>
```

- `name` (required) — workspace name (e.g. `gh-565-fix-validation`)

Call `mcp__pitch__get_workspace` with `name`.

**Example:** `/pitch get gh-565-fix-validation`

### `resume` — Resume a workspace agent

```
/pitch resume <name> [--agent <agent>]
```

- `name` (required) — workspace name
- `--agent` — override agent type for this resumption

Call `mcp__pitch__resume_workspace` with `name` and optionally `agent`.

**Example:** `/pitch resume gh-565-fix-validation`

### `close` — Close a workspace

```
/pitch close <name> [--cleanup-worktree]
```

- `name` (required) — workspace name
- `--cleanup-worktree` — if present, remove the git worktree

Call `mcp__pitch__close_workspace` with `name` and `cleanup_worktree` (true if flag present, false otherwise).

**Example:** `/pitch close gh-565-fix-validation --cleanup-worktree`

### `ping` — Health check

```
/pitch ping
```

No arguments. Call `mcp__pitch__ping`.

## Behavior

1. If the first argument is a number, treat it as `create <issue>` (implicit default).
2. Otherwise, parse the first argument as a subcommand (`create`, `list`, `get`, `resume`, `close`, `ping`).
3. Parse remaining positional args and `--flags` according to the subcommand spec above.
4. Call the corresponding `mcp__pitch__*` tool with the parsed parameters.
5. Present the tool's response to the user.

If no arguments are provided, show a brief usage summary listing the available subcommands.

If a required argument is missing, tell the user which argument is needed and show the usage for that subcommand.
