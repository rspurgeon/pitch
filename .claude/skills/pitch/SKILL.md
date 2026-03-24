---
name: pitch
description: Invoke Pitch MCP server tools to manage coding agent workspaces.
  Use this skill whenever the user runs /pitch or asks to create, list, get,
  resume, or close a workspace, or wants to ping the Pitch server. This is the
  primary interface for orchestrating git worktrees, tmux windows, and coding
  agent sessions from GitHub issues.
---

# Pitch — Workspace Orchestration

This skill parses `/pitch` arguments and calls the corresponding Pitch MCP
tool.

## Argument Format

```text
/pitch [subcommand] [positional args] [--flags]
```

Default behavior: if the first argument is a number, `create` is implied. This
means `/pitch 565 fix-validation` is equivalent to
`/pitch create 565 fix-validation`.

## Subcommands

### `create` (default) — Create a new workspace

```text
/pitch <issue> <slug> [--agent <agent>] [--model <model>] [--repo <org/repo>] [--base-branch <branch>] [--runtime <native|docker>]
/pitch create <issue> <slug> [--flags]
```

- `issue` (required) — GitHub issue number (integer)
- `slug` (required) — descriptive text for branch naming
  (for example `fix-validation`)
- `--agent` — configured Pitch agent name such as `codex-native`,
  `claude-enterprise`, or `claude-personal`
- `--model` — model override for this workspace
- `--repo` — GitHub org/repo (for example `kong/kongctl`)
- `--base-branch` — branch to create from
- `--runtime` — `native` or `docker`

Call `mcp__pitch__create_workspace` with the parsed parameters:
- `issue` → number
- `slug` → string
- `repo`, `base_branch`, `agent`, `runtime`, `model` → string
  (only include if provided)

If `--agent` is omitted, Pitch will resolve the agent from repo defaults or
global defaults in its config.

Examples:
- `/pitch 565 fix-validation`
- `/pitch 565 fix-validation --agent claude-enterprise`
- `/pitch create 565 fix-validation --agent codex-native --model gpt-5.4`

### `list` — List workspaces

```text
/pitch list [--status <active|closed|all>] [--repo <org/repo>]
```

Call `mcp__pitch__list_workspaces` with:
- `status` → string (only if provided)
- `repo` → string (only if provided)

Example: `/pitch list --status active`

### `get` — Get workspace details

```text
/pitch get <name>
```

- `name` (required) — exact workspace name
  (for example `gh-565-fix-validation`)

Call `mcp__pitch__get_workspace` with `name`.

Example: `/pitch get gh-565-fix-validation`

### `resume` — Resume a workspace agent

```text
/pitch resume <name> [--agent <agent>]
```

- `name` (required) — workspace name
- `--agent` — optional configured Pitch agent name to use for this resume

Call `mcp__pitch__resume_workspace` with `name` and optionally `agent`.

Example: `/pitch resume gh-565-fix-validation`

### `close` — Close a workspace

```text
/pitch close <name> [--keep-worktree]
```

- `name` (required) — workspace name
- `--keep-worktree` — keep the git worktree on disk instead of fully cleaning
  it up

Default close behavior is full cleanup:
- close the tmux window
- remove the git worktree
- remove the workspace state file

Call `mcp__pitch__close_workspace` with:
- `name` → string
- `cleanup_worktree` → `false` only when `--keep-worktree` is present

If `--keep-worktree` is not present, either omit `cleanup_worktree` or pass
`true`.

Example: `/pitch close gh-565-fix-validation --keep-worktree`

### `ping` — Health check

```text
/pitch ping
```

No arguments. Call `mcp__pitch__ping`.

The response is a server status/config summary, not just a literal `"pong"`.

## Behavior

1. If the first argument is a number, treat it as `create <issue>`
   (implicit default).
2. Otherwise, parse the first argument as a subcommand:
   `create`, `list`, `get`, `resume`, `close`, or `ping`.
3. Parse remaining positional args and `--flags` according to the subcommand
   spec above.
4. Call the corresponding `mcp__pitch__*` tool with the parsed parameters.
5. Present the tool's response to the user.

If no arguments are provided, show a brief usage summary listing the available
subcommands.

If a required argument is missing, tell the user which argument is needed and
show the usage for that subcommand.
