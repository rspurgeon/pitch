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

Each issue below is a self-contained unit of work suitable for a coding agent session. Issues are sequenced by dependency.

---

### Issue 1: Project Scaffolding

**Title:** Initialize Pitch TypeScript project with MCP SDK

**Description:**

Set up the Pitch project as a TypeScript MCP server using stdio transport.

**Acceptance Criteria:**

- TypeScript project initialized with `package.json` and `tsconfig.json`
- `@modelcontextprotocol/sdk` installed as dependency
- `tsx` configured for running TypeScript directly
- Minimal MCP server that starts, accepts stdio connections, and exposes a single `ping` tool that returns `pong`
- `npm start` launches the server
- README with project description and setup instructions
- `.gitignore` configured for Node/TypeScript

**Dependencies:** None

---

### Issue 2: Configuration Loading

**Title:** Implement Pitch configuration loading from YAML

**Description:**

Pitch needs to load its configuration from `~/.pitch/config.yaml`. The config defines repos, agents, defaults, and runtime settings. Support default values when config is missing or partial.

**Acceptance Criteria:**

- Reads config from `~/.pitch/config.yaml`
- Parses YAML into typed TypeScript interfaces
- Provides sensible defaults when config file is missing or fields are omitted
- Config types cover: `defaults` (repo, agent, base_branch), `repos` (main_worktree, worktree_base, tmux_session), `agents` (runtime, env, defaults per agent), `agent_profiles` (profile name → base agent, env overrides, default overrides)
- Validates required fields and reports clear errors
- Config is loaded once at startup and accessible throughout the application
- Unit tests for config parsing, defaults, and validation

**Dependencies:** Issue 1

---

### Issue 3: Workspace State Persistence

**Title:** Implement workspace state read/write to YAML files

**Description:**

Pitch stores workspace records as individual YAML files in `~/.pitch/workspaces/`. Implement the data layer for creating, reading, updating, listing, and deleting workspace records.

**Acceptance Criteria:**

- Workspace state directory created at `~/.pitch/workspaces/` if missing
- Write workspace record to `{workspace_name}.yaml`
- Read single workspace by name
- List all workspaces, optionally filtered by status or repo
- Update existing workspace record (e.g. add agent session, change status)
- Typed TypeScript interfaces for workspace state matching the schema defined in this document
- Unit tests for CRUD operations

**Dependencies:** Issue 1

---

### Issue 4: Git Worktree Management

**Title:** Implement git worktree creation and removal

**Description:**

Pitch creates git worktrees for each workspace using `git worktree add` and optionally removes them with `git worktree remove`. The worktree is created from the repo's main worktree directory.

**Acceptance Criteria:**

- Create a worktree: `git worktree add -b {branch} {worktree_path} {base_branch}` executed from the main worktree directory
- Remove a worktree: `git worktree remove {worktree_path}`
- Verify main worktree exists before operations
- Detect if branch or worktree already exists and handle gracefully
- Worktree path constructed from config: `{worktree_base}/{workspace_name}`
- Functions accept typed inputs (repo config, workspace name, base branch)
- Integration tests that create and remove actual worktrees in a temp git repo

**Dependencies:** Issue 2

---

### Issue 5: tmux Orchestration

**Title:** Implement tmux session, window, and pane management

**Description:**

Pitch manages tmux windows and panes for workspaces. It creates windows in existing (or new) tmux sessions and sets up the three-pane layout.

**Acceptance Criteria:**

- Check if a tmux session exists by name
- Create a tmux session if it doesn't exist
- Create a named tmux window within a session
- Split the window into the three-pane layout (left tall pane, right split into top and bottom)
- Run `cd {worktree_path}` in all three panes
- Send a command to a specific pane (for agent launch)
- Detect if a window with the given name already exists
- Functions are pure wrappers around `tmux` commands with typed inputs/outputs
- Integration tests (can be skipped in CI if tmux not available, but documented for local testing)

**Dependencies:** Issue 1

---

### Issue 6: Agent Launcher Abstraction

**Title:** Implement agent launcher with native and Docker runtime support

**Description:**

Pitch needs to build the correct command to launch or resume a coding agent, supporting both native execution and Docker via `agent-en-place`. Each agent type (Claude Code, Codex) has different CLI flags and session management. Agents also support multi-account usage through environment variables (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, etc.), exposed via agent profiles in Pitch config.

**Acceptance Criteria:**

- `AgentLauncher` interface with `buildStartCommand` and `buildResumeCommand` methods
- Claude Code implementation: generates start command with `--session-id`, `--cd`, `--name`, and configured flags; resume command with `--resume`
- Codex implementation: generates start command with `--cd` and configured flags; resume command with `codex resume {session_id}`
- Native runtime: returns the command array directly
- Docker runtime: wraps the command through `agent-en-place` (shell out to `agent-en-place {agent_type}` with appropriate environment)
- Configuration layering: agent defaults from config merged with workspace-level overrides
- Environment variable support: agent `env` block forwarded to the process; for Docker, forwarded into the container
- Profile resolution: if the `agent` param matches a profile name, resolve the base agent type and merge profile env/defaults over the base config
- Session ID handling: pre-generate UUID for Claude, placeholder for Codex (discovered post-launch)
- Unit tests for command generation across agent types, runtimes, profiles, and config combinations

**Dependencies:** Issue 2

---

### Issue 7: `create_workspace` MCP Tool

**Title:** Implement the `create_workspace` MCP tool

**Description:**

This is the primary MCP tool — it orchestrates all subsystems to create a complete workspace from a GitHub issue. This tool wires together config, git, tmux, agent launcher, and state persistence.

**Acceptance Criteria:**

- Registered as an MCP tool with the parameter schema defined in this document
- Validates inputs (issue required, slug required)
- Resolves repo config (using param or default)
- Constructs workspace name: `gh-{issue}-{slug}`
- Checks for existing workspace with same name (error if exists)
- Calls git worktree creation
- Calls tmux window and pane creation
- Calls agent launcher to build start command
- Sends start command to the agent pane via tmux
- For Claude: stores pre-generated session ID in workspace record
- For Codex: records that session ID is pending discovery
- Persists workspace record
- Returns the workspace record
- Error handling: rolls back partial state on failure (e.g. remove worktree if tmux creation fails)

**Dependencies:** Issues 2, 3, 4, 5, 6

---

### Issue 8: `list_workspaces` and `get_workspace` MCP Tools

**Title:** Implement workspace query MCP tools

**Description:**

Expose read-only workspace query tools via MCP.

**Acceptance Criteria:**

- `list_workspaces` tool: returns array of workspace summaries, supports optional `status` and `repo` filters
- `get_workspace` tool: returns full workspace record by name, returns clear error if not found
- Both registered as MCP tools with appropriate parameter schemas
- Workspace summaries include: name, repo, issue, status, agent type, tmux session/window

**Dependencies:** Issues 3, 7

---

### Issue 9: `close_workspace` MCP Tool

**Title:** Implement the `close_workspace` MCP tool

**Description:**

Close a workspace by marking it inactive. Optionally remove the git worktree.

**Acceptance Criteria:**

- Registered as MCP tool with parameter schema
- Updates workspace status to `closed`
- If `cleanup_worktree` is true, removes the git worktree
- Does not destroy the tmux window (user may want to review)
- Updates workspace record on disk
- Returns updated workspace record
- Error if workspace not found or already closed

**Dependencies:** Issues 3, 4

---

### Issue 10: `resume_workspace` MCP Tool

**Title:** Implement the `resume_workspace` MCP tool

**Description:**

Resume a coding agent session in an existing workspace. Finds the most recent session ID and relaunches the agent in the workspace's tmux pane.

**Acceptance Criteria:**

- Registered as MCP tool with parameter schema
- Verifies workspace exists and tmux window is present
- Retrieves most recent agent session ID from workspace record
- Builds resume command via agent launcher
- Sends resume command to the agent pane via tmux
- Adds new agent session entry to workspace record
- Handles case where no previous session exists (launches fresh instead of resuming)
- Optionally allows overriding agent type for this resumption
- Returns updated workspace record

**Dependencies:** Issues 3, 5, 6

---

### Issue 11: Codex Session ID Discovery

**Title:** Implement Codex session ID capture from exit output

**Description:**

When Codex exits, it prints `To continue this session, run codex resume {session_id}`. Pitch needs to capture this from the tmux pane to update the workspace record.

This is not automated in the MVP — it's a utility MCP tool the user can invoke after a Codex session ends to capture and store the session ID.

**Acceptance Criteria:**

- `capture_session_id` MCP tool (or incorporated into existing workspace tools)
- Uses `tmux capture-pane` to read recent output from the agent pane
- Parses Codex exit output to extract session ID (regex on `codex resume {uuid}` pattern)
- Updates the workspace record with the discovered session ID
- Returns the captured session ID or clear error if not found
- Also handles Claude Code session ID verification if needed

**Dependencies:** Issues 3, 5

---

### Issue 12: End-to-End Testing and Documentation

**Title:** End-to-end testing and user documentation

**Description:**

Validate the full workflow and write user-facing documentation.

**Acceptance Criteria:**

- End-to-end test script that: creates a workspace, lists it, gets detail, closes it (using a test repo/config)
- README updated with: installation instructions, configuration guide, MCP tool reference, example usage with Claude Code as the Pilot
- Example config file included
- Instructions for configuring Claude Code to use Pitch as an MCP server (`claude mcp add pitch -- npx pitch-mcp`)
- Known limitations documented

**Dependencies:** All previous issues