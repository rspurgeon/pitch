# Pitch — Design Document

## Overview

Pitch is a local-first, terminal-native workspace
orchestration tool for managing coding sessions. It
automates the manual routine of going from a GitHub issue
or pull request to a fully configured development
workspace: git worktree, tmux window, coding agent — all
wired up and tracked.

Pitch exposes an MCP server over stdio. A user interacts
with Pitch through any MCP-capable agent (Claude Code,
Codex, etc.) acting as a "Pilot" — issuing natural
language commands that translate into MCP tool calls.
Pitch itself is not an agent; it is a deterministic
automation layer.

### What Pitch Does

When a user says "create workspace for issue 565 with slug
fix-validation" or "create workspace for PR 543 with slug
debug-ci", Pitch:

1. Resolves the source work item (issue or PR)
2. Creates or adopts the git worktree at the configured
   path
3. Creates or adopts the appropriate local branch
   (`gh-565-fix-validation` for an issue workspace, or the
   actual PR head branch for a PR workspace)
4. Finds or creates the project's tmux session
4. Creates a new tmux window named `gh-565-fix-validation`
5. Splits the window into a three-pane layout
6. Launches the configured coding agent in the left pane
7. Records the workspace state to disk

### Technology

- **Language:** TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Transport:** stdio (spawned by MCP client as child
  process)
- **State storage:** YAML files in `~/.pitch/`
- **External dependencies:** `git`, `tmux`, optionally `agent-en-place` for Docker

---

## Core Concepts

### Workspace

A workspace is Pitch's primary entity. It represents a
single unit of code work — one checked-out branch, one
worktree, one tmux window, one or more sequential coding
agent sessions.

A workspace is identified by its **workspace name** (for
example `gh-565-fix-validation` or `pr-543-debug-ci`).
This name is distinct from the git branch when Pitch is
working on a PR.

### Source Work Item

A GitHub issue or pull request is the external identity of
work. Pitch stores the source as:
- `source_kind: issue | pr`
- `source_number: <number>`

### Relationships

| Relationship | Cardinality | Notes |
|---|---|---|
| Issue → Workspace | 1:many | Separate slugs can produce multiple workspaces |
| PR → Workspace | 1:1 | Current implementation reuses the PR head branch, so Pitch tracks one workspace per PR |
| Workspace → Branch | 1:1 | PR workspaces may use a branch name different from the workspace name |
| Branch → Worktree | 1:1 | Git enforces this |
| Workspace → tmux window | 1:1 | Window named after workspace |
| tmux session → Repo | 1:1 | User convention, configured in Pitch |
| Workspace → Agent sessions | 1:many | Serial — one active at a time, history tracked |

### Naming Convention

Pitch uses safe workspace names:

- Issue workspace: `gh-{issue_number}-{slug}`
- PR workspace: `pr-{pr_number}-{slug}`

This string is used as:
- Worktree directory name
- tmux window name
- Workspace identifier in Pitch's state

For issue workspaces, the git branch usually matches the
workspace name. For PR workspaces, the git branch uses the
actual PR head branch name so it matches the PR, but users
may still need to set upstream or add a remote before a
plain `git push` will update that PR branch.

---

## Workspace Lifecycle

### Create

Inputs:
- **repo** (optional, defaults from config) — e.g. `kong/kongctl`
- **issue** or **pr** (exactly one required) — GitHub issue or PR number
- **slug** (required) — human-provided descriptive text
- **base_branch** (optional, issue workspaces only, defaults to `main`)
- **agent** (optional, defaults from config) — configured agent name such as
  `claude-enterprise`, `codex`, or `opencode`

Steps:
1. Resolve repo config (main worktree, worktree base, tmux session name)
2. Construct workspace name:
   `gh-{issue}-{slug}` or `pr-{pr}-{slug}`
3. Resolve the git start point:
   issue workspace from `base_branch`, or PR workspace by
   fetching `refs/pull/{pr}/head`
4. Run `git worktree add` from the main worktree,
   creating or adopting the branch and worktree
5. Check if the tmux session exists; create if not
6. Create a tmux window named after the workspace
7. Split into three-pane layout (agent left, empty
   top-right, shell bottom-right)
8. `cd` all panes to the worktree path
9. Launch the coding agent in the left pane via the agent
   launcher
10. Persist agent session state (pre-generated for Claude,
    pending for Codex and OpenCode until a later backfill)
11. Write workspace record to
    `~/.pitch/workspaces/{workspace_name}.yaml`

### List

Returns all tracked workspaces with status, source
kind/number, agent, and tmux location.

### Get

Returns full detail for a specific workspace.

### Resume

Relaunches the coding agent in an existing workspace's
tmux pane, using the most recent stored session ID for the
agent's resume command.

### Close

Closes the tmux window and, by default, removes the git
worktree and deletes the workspace state file.

---

## tmux Orchestration

### Session Management

Pitch does not own tmux sessions. They are typically
long-lived and created by the user (often restored via
tmux-resurrect on boot). Pitch creates a session only if
one doesn't exist for the repo.

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

The `worktree_base` is configured or derived per repo. The
worktree path is always based on the workspace name, not
the checked-out branch name.

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

Command args and env are assembled from four sources, in
priority order:

1. **Selected agent config** — args/env/runtime from the
   named entry under `agents`
2. **Repo agent overrides** — repo-specific args/env for
   that same named agent
3. **Workspace overrides** — per-workspace settings from
   `create_workspace` params
4. **Hardcoded requirements** — args Pitch always sets
   (for example Claude `--session-id` and `--name`, or
   Codex `--cd`)

### Agent Specifics

**Claude Code:**

```
# Start
claude --session-id {uuid} --name {workspace_name} [user flags] [prompt]

# Resume
claude --resume {session_id}
```

Session ID is pre-generated (UUID) and passed at launch.
Pitch controls the ID. Claude runs in the tmux pane whose
working directory has already been changed to the worktree.

**Codex:**

```
# Start
codex --cd {worktree_path} [user flags] [prompt]

# Resume
codex resume {session_id}
```

Session ID is discovered after launch from `~/.codex/sessions/` or captured from exit output (`To continue this session, run codex resume {id}`).

**OpenCode:**

```
# Start
opencode [user flags] [--prompt {prompt}] {worktree_path}

# Resume
opencode --session {session_id}
```

OpenCode sessions are persisted under
`~/.local/share/opencode/storage/session/`. Pitch starts
new OpenCode workspaces with a pending session ID and
backfills the real ID later when it can match the stored
session metadata to the workspace path. If OpenCode is
configured in attach mode, Pitch supplies the workspace
path to `--dir` for both create and resume. Attach mode
does not expose a prompt flag, so Pitch best-effort sends
the bootstrap prompt into the tmux pane after launch.

When a repo config includes `additional_paths`, Pitch
translates them into OpenCode
`permission.external_directory` entries, writes a
generated config file at
`~/.pitch/opencode/{workspace_name}.json`, and launches
OpenCode with `OPENCODE_CONFIG` pointing at that file.
This keeps user-local paths out of the repo while still
letting OpenCode merge the generated permissions with its
global and project config layers.

### Docker via agent-en-place

When runtime is `docker`, Pitch delegates container management to `agent-en-place`:

- `agent-en-place` builds a Docker image with the right tool versions (via mise)
- Mounts the worktree as `/workdir`
- Mounts agent config directories for session persistence
- Forwards credentials (API keys, git config, SSH keys)
- Runs the agent with full permissions inside the container

Pitch passes the agent type to `agent-en-place` and appends its own flags. Pitch
does not need to understand Docker internals. OpenCode support is native-only
for now.

### Multi-Account Agent Support

Coding agents don't natively support multiple accounts, but their behavior can be changed through environment variables:

- **Claude Code:** `CLAUDE_CONFIG_DIR` changes where Claude reads its config, credentials, and session data. Pointing to a different directory effectively switches accounts.
- **Codex:** `CODEX_HOME` changes the config/session root. `OPENAI_API_KEY` can be overridden per invocation.

Pitch supports this through named entries under `agents`.
Multiple entries can share the same underlying `type`
while using different `env`, `args`, or `runtime`
settings. When creating a workspace, you select one of
those named entries directly:

```
create_workspace --issue 565 --slug fix-bug --agent claude-personal
```

Pitch resolves `claude-personal` as the selected agent
entry, then applies any repo-specific overrides for that
same key. This means the agent process starts with
`CLAUDE_CONFIG_DIR=~/.claude-personal`, using a
completely separate set of credentials, settings, and
session history.

The user sets up each config directory independently (e.g. `CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login`). Pitch doesn't manage authentication — it just points the agent at the right config directory.

---

## Configuration

Stored at `~/.pitch/config.yaml`:

```yaml
defaults:
  repo: kong/kongctl
  agent: codex
  base_branch: main
  worktree_root: ~/.local/share/worktrees

bootstrap_prompts:
  issue: Read GitHub issue #{issue_number} in {repo} using gh and wait.
  pr: Read GitHub PR #{pr_number} in {repo} using gh and wait.

repos:
  kong/kongctl:
    default_agent: claude-enterprise
    main_worktree: ~/dev/kong/kongctl
    additional_paths:
      - /home/rspurgeon/go
    bootstrap_prompts:
      pr: Read repo PR #{pr_number} in {repo} on {branch} and wait.
    agent_overrides:
      claude-enterprise:
        runtime: docker
      codex:
        args:
          - --add-dir
          - /home/rspurgeon/.config/kongctl

agents:
  codex:
    type: codex
    runtime: native
    args:
      - --model
      - gpt-5.4
      - --sandbox
      - workspace-write
      - --ask-for-approval
      - on-request
    env:
      CODEX_HOME: ~/.codex

  claude-enterprise:
    type: claude
    runtime: native
    args:
      - --model
      - sonnet
      - --permission-mode
      - bypassPermissions
    env:
      CLAUDE_CONFIG_DIR: ~/.claude

  claude-personal:
    type: claude
    runtime: native
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-personal
    args:
      - --model
      - opus

  codex-api:
    type: codex
    runtime: native
    env:
      CODEX_HOME: ~/.codex-api
      OPENAI_API_KEY: ${OPENAI_API_KEY_SECONDARY}
```

If a repo omits `worktree_base`, Pitch derives it as
`{defaults.worktree_root}/{owner}/{repo}`. If a repo omits
`tmux_session`, Pitch uses the repo name segment
(`kongctl` for `kong/kongctl`).

Repo `additional_paths` are translated per agent type:

- Claude and Codex receive repeated `--add-dir` flags.
- OpenCode receives generated
  `permission.external_directory` config written under
  `~/.pitch/opencode/` and referenced via
  `OPENCODE_CONFIG` on both create and fresh relaunch.

Bootstrap prompt templates resolve in this order:

1. `repos.<repo>.bootstrap_prompts.<issue|pr>`
2. top-level `bootstrap_prompts.<issue|pr>`
3. Pitch built-in default prompt

---

## Workspace State

Stored at `~/.pitch/workspaces/{workspace_name}.yaml`:

```yaml
name: gh-565-fix-validation
repo: kong/kongctl
source_kind: issue
source_number: 565
branch: gh-565-fix-validation
worktree_path: ~/.local/share/worktrees/kong/kongctl/gh-565-fix-validation
base_branch: main
tmux_session: kongctl
tmux_window: gh-565-fix-validation
agent_name: codex
agent_type: codex
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

Creates a new workspace: branch, worktree, tmux window,
pane layout, agent launch, GitHub lifecycle automation,
state persistence.

If no workspace state file exists but the expected
branch, worktree path, or tmux window already exists for
the derived workspace name, Pitch adopts those matching
resources instead of failing. Existing tracked workspaces
are still rejected.

When Pitch launches a fresh agent process, it also:
- best-effort assigns the source issue or PR to the
  current `gh` user
- for issues, best-effort updates compatible GitHub
  Project items to `In Progress`
- sends a read-only bootstrap prompt telling the agent
  to read the issue or PR and wait

If Pitch adopts an already-running agent pane, it still
does the GitHub lifecycle automation but does not inject a
bootstrap prompt into that live session.

**Parameters:**
- `repo` (string, optional) — GitHub org/repo, defaults from config
- exactly one of:
  - `issue` (number)
  - `pr` (number)
- `slug` (string, required) — descriptive text for naming
- `base_branch` (string, optional) — branch to create
  from for issue workspaces, defaults to `main`
- `agent` (string, optional) — configured agent name like `codex`,
  `claude-enterprise`, or `claude-personal`, defaults from config
- `runtime` (string, optional) — `native` or `docker`, defaults from agent config
- `model` (string, optional) — override default model for this workspace

**Returns:** Workspace record

### `list_workspaces`

Lists all tracked workspaces with status, source
kind/number, agent, and tmux location.

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

Relaunches the coding agent in an existing workspace, using the most recent
session ID. For native Codex workspaces whose latest session is still pending,
Pitch may recover the real session ID from the local Codex session store before
falling back to a fresh launch.

On a true session resume, Pitch does not re-run GitHub
lifecycle automation or re-send the bootstrap prompt. On
a fresh relaunch fallback, it does both.

**Parameters:**
- `name` (string, required) — workspace name
- `agent` (string, optional) — override agent type for this resumption

**Returns:** Updated workspace record with new agent session entry

### `close_workspace`

Closes a workspace by tearing down its tmux window. By
default it also removes the git worktree and deletes the
workspace state file.

**Parameters:**
- `name` (string, required) — workspace name
- `cleanup_worktree` (boolean, optional) — if `false`,
  keep the workspace state file and worktree as a closed
  record; defaults to `true`

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
