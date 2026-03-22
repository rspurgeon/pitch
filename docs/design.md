# Pitch — Design Document

## Overview

Pitch is a local-first, terminal-native workspace orchestration tool for managing coding sessions. It automates the manual routine of going from a GitHub issue to a fully configured development workspace: git worktree, tmux window, coding agent — all wired up and tracked.

Pitch exposes an MCP server over stdio. A user interacts with Pitch through any MCP-capable agent (Claude Code, Codex, etc.) acting as a "Pilot" — issuing natural language commands that translate into MCP tool calls. Pitch itself is not an agent; it is a deterministic automation layer.

### What Pitch Does

When a user says "create workspace for issue 565 with slug fix-validation", Pitch:

1. Creates a git branch `gh-565-fix-validation` from the base branch
2. Creates a git worktree at the configured path
3. Finds or creates the project's tmux session
4. Creates a new tmux window named `gh-565-fix-validation`
5. Splits the window into a three-pane layout
6. Launches the configured coding agent in the left pane
7. Records the workspace state to disk

### Technology

- **Language:** TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Transport:** stdio (spawned by MCP client as child process)
- **State storage:** YAML files in `~/.pitch/`
- **External dependencies:** `git`, `tmux`, optionally `agent-en-place` for Docker

---

## Core Concepts

### Workspace

A workspace is Pitch's primary entity. It represents a single unit of code work — one branch, one worktree, one tmux window, one or more sequential coding agent sessions.

A workspace is identified by its **branch name** (e.g. `gh-565-fix-validation`). Everything else is derived or looked up.

### Issue

A GitHub issue is the external identity of work. One issue can have multiple workspaces (multiple PRs solving different aspects of the issue). The issue number is embedded in the branch naming convention. Pitch uses the issue for grouping and lifecycle signals (issue closed → workspace eligible for cleanup).

### Relationships

| Relationship | Cardinality | Notes |
|---|---|---|
| Issue → Workspace | 1:many | Usually 1:1, but multi-PR issues create multiple workspaces |
| Workspace → Branch | 1:1 | Branch name IS the workspace identity |
| Branch → Worktree | 1:1 | Git enforces this |
| Workspace → tmux window | 1:1 | Window named after workspace |
| tmux session → Repo | 1:1 | User convention, configured in Pitch |
| Workspace → Agent sessions | 1:many | Serial — one active at a time, history tracked |
| Workspace → PR | 1:1 | One PR per branch (standard GitHub flow) |

### Naming Convention

All layers use the same identifier string:

- Format: `gh-{issue_number}-{slug}`
- Example: `gh-565-fix-validation`

This string is used as:
- Git branch name
- Worktree directory name
- tmux window name
- Workspace identifier in Pitch's state

---

## Workspace Lifecycle

### Create

Inputs:
- **repo** (optional, defaults from config) — e.g. `kong/kongctl`
- **issue** (required) — GitHub issue number
- **slug** (required) — human-provided descriptive text
- **base_branch** (optional, defaults to `main`)
- **agent** (optional, defaults from config) — `claude` or `codex`

Steps:
1. Resolve repo config (main worktree, worktree base, tmux session name)
2. Construct workspace name: `gh-{issue}-{slug}`
3. Run `git worktree add` from the main worktree, creating the branch and worktree
4. Check if the tmux session exists; create if not
5. Create a tmux window named after the workspace
6. Split into three-pane layout (agent left, empty top-right, shell bottom-right)
7. `cd` all panes to the worktree path
8. Launch the coding agent in the left pane via the agent launcher
9. Capture agent session ID (pre-generated for Claude, discovered for Codex)
10. Write workspace record to `~/.pitch/workspaces/{workspace_name}.yaml`

### List

Returns all tracked workspaces with status, issue, agent, and tmux location.

### Get

Returns full detail for a specific workspace.

### Resume

Relaunches the coding agent in an existing workspace's tmux pane, using the most recent stored session ID for the agent's resume command.

### Close

Marks workspace as inactive. Optionally removes the git worktree. Does not delete the tmux window (user may want to review output).

---

## tmux Orchestration

### Session Management

Pitch does not own tmux sessions. They are typically long-lived and created by the user (often restored via tmux-resurrect on boot). Pitch creates a session only if one doesn't exist for the repo.

Pitch never modifies existing windows or panes it didn't create. It only adds new windows.

### Pane Layout

Fixed three-pane layout per workspace:

```
┌──────────────────┬──────────────────┐
│                  │                  │
│   Coding Agent   │   (empty shell)  │
│                  │                  │
│                  ├──────────────────┤
│                  │                  │
│                  │   (empty shell)  │
│                  │                  │
└──────────────────┴──────────────────┘
```

- Left pane (tall): coding agent runs here
- Top-right: user opens nvim or whatever they want
- Bottom-right: ad hoc command line

All three panes `cd` to the worktree path on creation.

---

## Git Worktree Management

Pitch calls `git worktree add` directly. It does not depend on external worktree tools (lazyworktree, etc.).

Worktree path convention:

```
{worktree_base}/{workspace_name}
```

Example:

```
~/.local/share/worktrees/kong/kongctl/gh-565-fix-validation
```

The `worktree_base` is configured per repo.

---

## Agent Launcher Abstraction

Pitch separates agent concerns into three layers:

### 1. Agent Type

Each agent (Claude Code, Codex) has its own CLI interface, flag format, and session management. Pitch implements an agent-specific module that knows how to:

- Build a start command with the right flags
- Build a resume command with a session ID
- Discover or assign a session ID

### 2. Runtime

The runtime determines _where_ the agent process runs:

- **Native:** Agent runs directly on the host machine
- **Docker:** Agent runs inside a Docker container via `agent-en-place`

Docker provides a sandbox: the agent can run with maximum permissions (`--dangerously-skip-permissions` for Claude, `--dangerously-bypass-approvals-and-sandbox` for Codex) because the container is the real security boundary.

### 3. Configuration Layering

Command flags are assembled from three sources, in priority order:

1. **Agent defaults** (from Pitch config) — applied to every workspace for that agent type
2. **Workspace overrides** (from `create_workspace` params) — per-workspace settings
3. **Hardcoded requirements** — flags Pitch always sets (e.g. `--cd` for worktree path)

### Agent Specifics

**Claude Code:**

```
# Start
claude --session-id {uuid} --cd {worktree_path} --name {workspace_name} [user flags]

# Resume
claude --resume {session_id}
```

Session ID is pre-generated (UUID) and passed at launch. Pitch controls the ID.

**Codex:**

```
# Start
codex --cd {worktree_path} [user flags]

# Resume
codex resume {session_id}
```

Session ID is discovered after launch from `~/.codex/sessions/` or captured from exit output (`To continue this session, run codex resume {id}`).

### Docker via agent-en-place

When runtime is `docker`, Pitch delegates container management to `agent-en-place`:

- `agent-en-place` builds a Docker image with the right tool versions (via mise)
- Mounts the worktree as `/workdir`
- Mounts agent config directories for session persistence
- Forwards credentials (API keys, git config, SSH keys)
- Runs the agent with full permissions inside the container

Pitch passes the agent type to `agent-en-place` and appends its own flags. Pitch does not need to understand Docker internals.

### Multi-Account / Profile Support

Coding agents don't natively support multiple accounts, but their behavior can be changed through environment variables:

- **Claude Code:** `CLAUDE_CONFIG_DIR` changes where Claude reads its config, credentials, and session data. Pointing to a different directory effectively switches accounts.
- **Codex:** `CODEX_HOME` changes the config/session root. `OPENAI_API_KEY` can be overridden per invocation.

Pitch supports this through **agent profiles**. A profile extends a base agent type with alternate environment variables and defaults. When creating a workspace, you can specify a profile instead of (or in addition to) an agent type:

```
create_workspace --issue 565 --slug fix-bug --agent claude-personal
```

Pitch resolves `claude-personal` as a profile, looks up the base agent (`claude`), merges the profile's `env` and `defaults` over the base, and launches accordingly. This means the agent process starts with `CLAUDE_CONFIG_DIR=~/.claude-personal`, using a completely separate set of credentials, settings, and session history.

The user sets up each config directory independently (e.g. `CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login`). Pitch doesn't manage authentication — it just points the agent at the right config directory.

---

## Configuration

Stored at `~/.pitch/config.yaml`:

```yaml
defaults:
  repo: kong/kongctl
  agent: codex
  base_branch: main

repos:
  kong/kongctl:
    main_worktree: ~/dev/kong/kongctl
    worktree_base: ~/.local/share/worktrees/kong/kongctl
    tmux_session: kongctl

agents:
  codex:
    runtime: native
    defaults:
      model: gpt-5.4
      sandbox: workspace-write
      approval: on-request
    env:
      CODEX_HOME: ~/.codex

  claude:
    runtime: docker
    defaults:
      model: sonnet
      permission_mode: dangerously-skip-permissions
    env:
      CLAUDE_CONFIG_DIR: ~/.claude

# Agent profiles allow running agents with different accounts, API keys, or settings.
# A profile overrides the base agent config with alternate env vars and defaults.
agent_profiles:
  claude-personal:
    agent: claude
    runtime: native
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-personal
    defaults:
      model: opus

  codex-api:
    agent: codex
    env:
      CODEX_HOME: ~/.codex-api
      OPENAI_API_KEY: ${OPENAI_API_KEY_SECONDARY}
```

---

## Workspace State

Stored at `~/.pitch/workspaces/{workspace_name}.yaml`:

```yaml
name: gh-565-fix-validation
repo: kong/kongctl
issue: 565
branch: gh-565-fix-validation
worktree_path: ~/.local/share/worktrees/kong/kongctl/gh-565-fix-validation
base_branch: main
tmux_session: kongctl
tmux_window: gh-565-fix-validation
agent_type: codex
agent_profile: null
agent_runtime: native
agent_env:
  CODEX_HOME: ~/.codex
agent_sessions:
  - id: "019d11a3-0c62-76b0-a4c0-59056df51009"
    started_at: "2026-03-20T10:30:00Z"
    status: active
status: active
created_at: "2026-03-20T10:30:00Z"
updated_at: "2026-03-20T10:30:00Z"
```

---

## MCP Tools (MVP)

Pitch exposes the following MCP tools over stdio:

### `create_workspace`

Creates a new workspace: branch, worktree, tmux window, pane layout, agent launch, state persistence.

**Parameters:**
- `repo` (string, optional) — GitHub org/repo, defaults from config
- `issue` (number, required) — GitHub issue number
- `slug` (string, required) — descriptive text for naming
- `base_branch` (string, optional) — branch to create from, defaults to `main`
- `agent` (string, optional) — `claude` or `codex`, or a profile name like `claude-personal`, defaults from config
- `runtime` (string, optional) — `native` or `docker`, defaults from agent config
- `model` (string, optional) — override default model for this workspace

**Returns:** Workspace record

### `list_workspaces`

Lists all tracked workspaces with status, issue, agent, and tmux location.

**Parameters:**
- `status` (string, optional) — filter by `active`, `closed`, or `all`
- `repo` (string, optional) — filter by repo

**Returns:** Array of workspace summaries

### `get_workspace`

Returns full detail for a specific workspace.

**Parameters:**
- `name` (string, required) — workspace name (branch name)

**Returns:** Full workspace record

### `resume_workspace`

Relaunches the coding agent in an existing workspace, using the most recent session ID.

**Parameters:**
- `name` (string, required) — workspace name
- `agent` (string, optional) — override agent type for this resumption

**Returns:** Updated workspace record with new agent session entry

### `close_workspace`

Marks a workspace as inactive and optionally cleans up the worktree.

**Parameters:**
- `name` (string, required) — workspace name
- `cleanup_worktree` (boolean, optional) — remove the git worktree, defaults to `false`

**Returns:** Updated workspace record

---

## Security Model

Pitch runs locally, bound to stdio. There is no network exposure.

The primary security consideration is Docker sandboxing for agents. When running in Docker via `agent-en-place`, agents get full permissions inside the container but can only access mounted paths. This is the recommended approach for autonomous agent work.

Native runtime trusts the agent's own permission model or the user's judgment.

---

## Deferred Features

The following are explicitly out of scope for the MVP but the design supports them:

- **Remote dispatch** — sending prompts to worker agents via `tmux send-keys` or Codex app-server, controlled from the Pilot session
- **Headless agent mode** — running agents via Codex app-server for structured programmatic interaction, with interactive resume capability
- **Cleanup automation** — polling GitHub issue status and suggesting workspace cleanup
- **Session output capture** — capturing agent pane output as workspace artifacts for continuity
- **GitHub webhook integration** — event-driven workspace lifecycle management
- **Port registry** — tracking dev server ports per workspace to avoid conflicts

---

## MVP Issues

MVP issues are tracked in [GitHub Issues](https://github.com/rspurgeon/pitch/issues).
