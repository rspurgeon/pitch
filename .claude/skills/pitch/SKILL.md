---
name: pitch
description: Invoke Pitch MCP server tools to manage coding agent workspaces.
  Use this skill whenever the user runs /pitch or asks to create, list, get,
  resume, or close a workspace, or wants to ping the Pitch server. This is the
  primary interface for orchestrating git worktrees, tmux windows, and coding
  agent sessions from GitHub issues or pull requests.
---

# Pitch — Workspace Orchestration

This skill parses `/pitch` arguments and calls the corresponding Pitch MCP
tool.

## Argument Format

```text
/pitch [subcommand] [positional args] [--flags]
```

Default behavior:
- if the first argument is a number, `create` from an issue is implied
- if the first argument starts with `#`, `create` from a PR is implied
- if the first argument is the literal `issue`, the next positional integer is
  the issue number
- if the first argument is the literal `pr`, the next positional integer or
  `#<number>` is the PR number

Examples:
- `/pitch 565 fix-validation` → issue workspace
- `/pitch #543 debug-ci` → PR workspace
- `/pitch issue 565 fix-validation` → issue workspace
- `/pitch pr 543 debug-ci` → PR workspace

## Subcommands

### `create` (default) — Create a new workspace

```text
/pitch <issue> <slug> [--agent <agent>] [--model <model>] [--repo <org/repo>] [--base-branch <branch>] [--runtime <native|docker>]
/pitch #<pr> <slug> [--agent <agent>] [--model <model>] [--repo <org/repo>] [--runtime <native|docker>]
/pitch issue <issue> <slug> [--agent <agent>] [--model <model>] [--repo <org/repo>] [--base-branch <branch>] [--runtime <native|docker>]
/pitch pr <pr> <slug> [--agent <agent>] [--model <model>] [--repo <org/repo>] [--runtime <native|docker>]
/pitch create <issue> <slug> [--flags]
/pitch create #<pr> <slug> [--flags]
/pitch create issue <issue> <slug> [--flags]
/pitch create pr <pr> <slug> [--flags]
```

- `issue` — GitHub issue number (integer)
- `#<pr>` — GitHub pull request number with a leading `#`
- `slug` (required) — descriptive text for branch naming
  (for example `fix-validation`)
- `--agent` — configured Pitch agent name such as `codex`,
  `claude-enterprise`, or `claude-personal`
- `--model` — model override for this workspace
- `--repo` — GitHub org/repo (for example `kong/kongctl`)
- `--base-branch` — branch to create from for issue workspaces only
- `--runtime` — `native` or `docker`

Map the first positional identifier to exactly one MCP field:
- plain integer like `565` → `issue: 565`
- hash-prefixed integer like `#543` → `pr: 543`
- explicit `issue 565` → `issue: 565`
- explicit `pr 543` or `pr #543` → `pr: 543`

Never send both `issue` and `pr` in the same
`mcp__pitch__create_workspace` call.

Do not reinterpret `#543` heuristically as an issue. A leading `#`
unambiguously means PR for this skill.

If the user explicitly says "PR", "pull request", or uses `#<number>`, create a
PR workspace and send `pr`, not `issue`.

If the user explicitly says "issue" or provides a bare integer without a `#`,
create an issue workspace and send `issue`, not `pr`.

Call `mcp__pitch__create_workspace` with:
- `issue` → number for issue workspaces only
- `pr` → number for PR workspaces only
- `slug` → string
- `repo`, `base_branch`, `agent`, `runtime`, `model` → string
  (only include if provided)

Underlying tool examples:

```text
/pitch 565 fix-validation
=> mcp__pitch__create_workspace({ issue: 565, slug: "fix-validation" })

/pitch #543 debug-ci
=> mcp__pitch__create_workspace({ pr: 543, slug: "debug-ci" })

/pitch pr 543 debug-ci
=> mcp__pitch__create_workspace({ pr: 543, slug: "debug-ci" })
```

If `--agent` is omitted, Pitch will resolve the agent from repo defaults or
global defaults in its config.

Examples:
- `/pitch 565 fix-validation`
- `/pitch #543 debug-ci`
- `/pitch pr 543 debug-ci`
- `/pitch 565 fix-validation --agent claude-enterprise`
- `/pitch create 565 fix-validation --agent codex --model gpt-5.4`

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

1. If the first argument is a number, treat it as
   `create <issue>` (implicit default).
2. If the first argument starts with `#`, parse the rest as
   digits and treat it as `create <pr>` (implicit default).
3. If the first argument is `issue`, parse the next positional value as the
   issue number and treat it as `create <issue>`.
4. If the first argument is `pr`, parse the next positional value as the PR
   number and treat it as `create <pr>`.
5. Otherwise, parse the first argument as a subcommand:
   `create`, `list`, `get`, `resume`, `close`, or `ping`.
6. Parse remaining positional args and `--flags` according to the subcommand
   spec above.
7. For `create`, translate the first positional identifier to
   exactly one MCP field:
   - number => `issue`
   - `#number` => `pr`
   - `issue <number>` => `issue`
   - `pr <number>` or `pr #<number>` => `pr`
8. Call the corresponding `mcp__pitch__*` tool with the parsed parameters.
9. Present the tool's response to the user.

If the create target is ambiguous, ask a short clarification question instead
of guessing.

If no arguments are provided, show a brief usage summary listing the available
subcommands.

If a required argument is missing, tell the user which argument is needed and
show the usage for that subcommand.
