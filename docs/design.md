# Pitch — Design Document

## Overview

Pitch is a local-first, terminal-native workspace
orchestration tool for managing coding sessions. It
automates the manual routine of going from a GitHub issue
or pull request to a fully configured development
workspace: git worktree, tmux window, coding agent — all
wired up and tracked.

Pitch exposes both a direct CLI and an MCP server over
stdio. Operators can invoke deterministic workspace
lifecycle commands directly, while MCP-capable agents
(Claude Code, Codex, etc.) can drive the same operations
through natural-language requests. Pitch itself is not an
agent; it is a deterministic automation layer.

### What Pitch Does

When a user says "create workspace for issue 565",
"create workspace for PR 543", or adds an optional slug
such as `fix-validation` or `debug-ci`, Pitch:

1. Resolves the source work item (issue or PR)
2. Creates or adopts the git worktree at the configured
   path
3. Creates or adopts the appropriate local branch
   (`gh-565-fix-validation` for an issue workspace, or the
   PR head branch when available for a PR workspace)
4. Finds or creates the project's tmux session
4. Creates a new tmux window named `gh-565-fix-validation`
5. Splits the window into a three-pane layout
6. Launches the configured coding agent in the left pane
7. Records the workspace state to disk

### Direct CLI Surface

The direct CLI is optimized for deterministic terminal
control when the operator already knows the desired
workspace action:

```bash
pitch --issue 565
pitch --pr 543
pitch create --issue 565 --slug fix-validation
pitch create --pr 543 --slug debug-ci
pitch list
pitch get pr-543-debug-ci
pitch resume pr-543-debug-ci
pitch resume pr-543-debug-ci --sync
pitch close pr-543-debug-ci
pitch delete pr-543-debug-ci
pitch completion zsh > ~/bin/functions/_pitch
```

Top-level verbs are the primary interface. `pitch
workspace <command> ...` may exist as a compatibility
alias, but workspace lifecycle remains the default command
surface because workspace is Pitch's primary entity.

Shell completion may be exposed from the CLI itself,
including dynamic completion of existing workspace names
for commands that target a workspace.

### Technology

- **Language:** TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Transport:** stdio (spawned by MCP client as child
  process)
- **State storage:** YAML files in `~/.pitch/`
- **External dependencies:** `git`, `tmux`, and optional `nono` sandboxing

---

## Core Concepts

### Workspace

A workspace is Pitch's primary entity. It represents a
single unit of code work — one tmux window and one or
more sequential coding agent sessions, backed by a
checked-out branch and worktree.

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
| PR → Workspace | 1:many | Multiple PR sessions may share one checkout |
| Workspace → Branch | many:1 | PR sessions share the PR head branch |
| Branch → Worktree | 1:1 | Git enforces this |
| Workspace → Worktree | many:1 | PR sessions may reuse one shared checkout |
| Workspace → tmux window | 1:1 | Window named after workspace |
| tmux session → Repo | 1:1 | User convention, configured in Pitch |
| Workspace → Agent sessions | 1:many | Serial — one active at a time, history tracked |

### Naming Convention

Pitch uses safe workspace names:

- Issue workspace: `gh-{issue_number}` or `gh-{issue_number}-{slug}`
- PR workspace: `pr-{pr_number}` or `pr-{pr_number}-{slug}`

This string is used as:
- tmux window name
- Workspace identifier in Pitch's state

For issue workspaces, the git branch usually matches the
workspace name. For PR workspaces, the slug names the
Pitch session, while the checkout uses the actual PR head
branch name. PR sessions may reuse an existing tracked
worktree on that branch or create a canonical PR-scoped
worktree such as `pr-543`.

---

## Workspace Lifecycle

### Create

Inputs:
- **repo** (optional, defaults from config) — e.g. `kong/kongctl`
- **issue** or **pr** (exactly one required) — GitHub issue or PR number
- **slug** (optional) — human-provided descriptive text
- **base_branch** (optional, issue workspaces only, defaults to `main`)
- **agent** (optional, defaults from config) — configured agent name such as
  `claude-enterprise`, `codex`, or `opencode`

Steps:
1. Resolve repo config (main worktree, worktree base, tmux session name)
2. Construct workspace name:
   `gh-{issue}` / `gh-{issue}-{slug}` or
   `pr-{pr}` / `pr-{pr}-{slug}`
3. Resolve the git start point:
   issue workspace from `base_branch`, or PR workspace by
   fetching `refs/pull/{pr}/head`
4. Resolve the checkout identity:
   issue workspaces use the workspace name; PR workspaces
   reuse an existing tracked checkout on the PR branch
   when available, otherwise they use a canonical
   PR-scoped worktree name such as `pr-{pr}`
5. Run `git worktree add` from the main worktree,
   creating or adopting the branch and worktree
6. Check if the tmux session exists; create if not
7. Create a tmux window named after the workspace
8. Split into three-pane layout (agent left, empty
   top-right, shell bottom-right)
9. `cd` all panes to the worktree path
10. Launch the coding agent in the left pane via the
    agent
   launcher
11. Persist agent session state (pre-generated for Claude,
    pending for Codex and OpenCode until a later backfill)
12. Write workspace record to
    `~/.pitch/workspaces/{workspace_name}.yaml`

### List

Returns all tracked workspaces with status, source
kind/number, agent, and tmux location.

### Get

Returns full detail for a specific workspace.

### Resume

Relaunches the coding agent in an existing workspace's
tmux pane, using the most recent stored session ID for the
agent's resume command. Closed workspaces remain tracked
and can be resumed later.

When `--sync` is requested for a PR workspace, Pitch
fetches the latest PR head and fast-forwards the local
branch before resuming. This is intentionally conservative:
Pitch refuses to sync if the worktree is dirty, if a
compatible agent pane is already running, or if the
workspace is not PR-backed.

### Close

Closes the tmux window and marks the workspace closed. The
worktree and state file remain so the workspace can be
resumed later.

### Delete

Deletes a workspace record and, when applicable, its git
worktree. Dirty worktrees are refused unless `--force` is
set. If multiple Pitch workspaces share one PR checkout,
Pitch deletes only the targeted workspace record and keeps
the shared worktree. If `delete_branch_if_empty` is set,
Pitch also deletes the local branch for non-PR workspaces
only when the branch has no commits outside `base_branch`
and no remote-tracking ref.

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
- Top-right: user shell, optionally seeded by
  `repos.<repo>.pane_commands.top_right`
- Bottom-right: user shell, optionally seeded by
  `repos.<repo>.pane_commands.bottom_right`

All three panes `cd` to the worktree path on creation.

---

## Git Worktree Management

Pitch calls `git worktree add` directly. It does not depend on external worktree tools (lazyworktree, etc.).

Worktree path convention:

```
{worktree_base}/{worktree_name}
```

Example:

```
~/.local/share/worktrees/kong/kongctl/gh-565-fix-validation
```

The `worktree_base` is configured or derived per repo. The
worktree path is based on the checkout identity
(`worktree_name`), which matches the workspace name for
issue workspaces but may be shared across multiple PR
sessions.

---

## Agent Launcher Abstraction

Pitch separates agent concerns into four layers:

### 1. Agent Type

Each agent (Claude Code, Codex) has its own CLI interface, flag format, and session management. Pitch implements an agent-specific module that knows how to:

- Build a start command with the right flags
- Build a resume command with a session ID
- Discover or assign a session ID

### 2. Execution Environment

The execution environment determines _where_ the agent
process runs:

- **Host:** Agent runs directly on the local machine
- **vm-ssh:** Agent runs in the guest through the existing
  SSH transport

### 3. Outer Sandbox

Pitch can optionally wrap the selected agent command in
`nono run`. This is the only outer sandbox layer. Agent
approval prompts remain enabled, but agent-native sandbox
flags are stripped or rejected when they conflict with the
outer sandbox.

### 4. Configuration Layering

Command args and env are assembled from four sources, in
priority order:

1. **Selected agent config** — args/env from the named
   entry under `agents`
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
global and project config layers. If the selected agent
already defines `OPENCODE_CONFIG`, Pitch merges that base
config into the generated workspace file before launch so
existing custom settings are preserved.

### Sandbox via nono

When a repo selects a sandbox preset, Pitch wraps the
agent command with `nono run` and passes the resolved
workspace root with `--workdir` and `--allow-cwd`.

Pitch resolves the nono profile in this order:

1. `sandbox.profiles.<agent-type>`
2. `sandbox.profile`
3. the built-in nono profile that matches the selected
   agent type

The built-in fallback mapping is:

- `codex` → `codex`
- `claude` → `claude-code`
- `opencode` → `opencode`

Repo-specific extra path access is still handled by
Pitch's existing `additional_paths` behavior. Capability
elevation is currently the escape hatch for everything the
nono profile does not already allow.

### Multi-Account Agent Support

Coding agents don't natively support multiple accounts, but their behavior can be changed through environment variables:

- **Claude Code:** `CLAUDE_CONFIG_DIR` changes where Claude reads its config, credentials, and session data. Pointing to a different directory effectively switches accounts.
- **Codex:** `CODEX_HOME` changes the config/session root. `OPENAI_API_KEY` can be overridden per invocation.

Pitch supports this through named entries under `agents`.
Multiple entries can share the same underlying `type`
while using different `env` and `args`
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
    sandbox: kongctl
    main_worktree: ~/dev/kong/kongctl
    pane_commands:
      top_right: nvim .
      bottom_right: make build
    additional_paths:
      - /home/rspurgeon/go
    bootstrap_prompts:
      pr: Read repo PR #{pr_number} in {repo} on {branch} and wait.
    agent_overrides:
      codex:
        args:
          - --add-dir
          - /home/rspurgeon/.config/kongctl

sandboxes:
  kongctl:
    provider: nono
    profiles:
      codex: /home/rspurgeon/.pitch/nono/profiles/kongctl-codex.json
    capability_elevation: true

agents:
  codex:
    type: codex
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
    args:
      - --model
      - sonnet
      - --permission-mode
      - bypassPermissions
    env:
      CLAUDE_CONFIG_DIR: ~/.claude

  claude-personal:
    type: claude
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-personal
    args:
      - --model
      - opus

  codex-api:
    type: codex
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

Repo pane commands run only when Pitch creates or
recreates the tmux layout for a workspace. Pitch does not
re-send them into an already-live window.

---

## Workspace State

Stored at `~/.pitch/workspaces/{workspace_name}.yaml`:

```yaml
name: gh-565-fix-validation
worktree_name: gh-565-fix-validation
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
the derived checkout identity, Pitch adopts those matching
resources instead of failing. For PR workspaces, Pitch may
also reuse an existing tracked worktree on the PR head
branch and create an additional tmux-backed session that
points at that shared checkout.

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
- `slug` (string, optional) — descriptive suffix for naming
- `base_branch` (string, optional) — branch to create
  from for issue workspaces, defaults to `main`
- `agent` (string, optional) — configured agent name like `codex`,
  `claude-enterprise`, or `claude-personal`, defaults from config
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
falling back to a fresh launch. Previously closed
workspaces can also be resumed.

Resume never re-sends the bootstrap prompt. On a true
session resume, Pitch also skips GitHub lifecycle
automation. On a fresh relaunch fallback, it may still
re-run GitHub lifecycle automation.

When `sync` is set for a PR workspace, Pitch fetches the
latest PR head and fast-forwards the existing branch before
resuming. Sync is refused when the worktree is dirty or a
compatible agent pane is already running.

**Parameters:**
- `name` (string, required) — workspace name
- `agent` (string, optional) — override agent type for this resumption
- `environment` (string, optional) — override execution environment
- `sync` (boolean, optional) — fast-forward a PR workspace to the latest
  upstream PR head before resuming

**Returns:** Updated workspace record with new agent session entry

### `close_workspace`

Closes a workspace by tearing down its tmux window and
marking it closed. The worktree and state file remain so
the workspace can be resumed later or explicitly deleted.

**Parameters:**
- `name` (string, required) — workspace name

**Returns:** Updated workspace record

### `delete_workspace`

Deletes a workspace by removing its state file and, when
applicable, its git worktree. If the worktree is dirty,
Pitch fails before tearing down the workspace unless
`force` is set. If multiple Pitch workspaces share the
same underlying checkout, Pitch only deletes the targeted
workspace record and leaves the shared worktree in place.

**Parameters:**
- `name` (string, required) — workspace name
- `force` (boolean, optional) — remove a dirty worktree
  anyway
- `delete_branch_if_empty` (boolean, optional) — delete
  the local branch only when it is unchanged from
  `base_branch` and appears unpushed

**Returns:** Final closed workspace record

---

## Security Model

Pitch runs locally, bound to stdio. There is no network exposure.

The primary security boundary is the optional outer
`nono` sandbox. When enabled, Pitch launches the agent
under `nono run` and leaves the agent's own approval
workflow enabled for interactive permission requests.

Without a configured sandbox, Pitch trusts the agent's own
permission model or the user's judgment.

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
