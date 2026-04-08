# Pitch

Pitch is a local-first workspace orchestration tool for
coding agent sessions. It takes a GitHub issue or pull
request and sets up everything a coding agent needs to
work: git branch, worktree, tmux window, and agent process
— all tracked and managed through a direct CLI or MCP
server.

See [docs/design.md](docs/design.md) for the full design
document.

## Prerequisites

- [mise](https://mise.jdx.dev/) — manages required tool
  versions
- `git` and `tmux` installed on your system

## Setup

```bash
git clone https://github.com/rspurgeon/pitch.git
cd pitch
mise trust && mise install
make install
```

## Use with an MCP Client

Pitch is a stdio MCP server. In normal use, you do not
launch it separately with `make start`. Instead, configure
your MCP client to spawn Pitch on demand.

## Direct CLI

When you already know which workspace lifecycle action you
want, use the direct CLI instead of routing through an
agent prompt:

```bash
npx tsx src/bin/pitch.ts --pr 700
npx tsx src/bin/pitch.ts create --pr 700 --slug default-aas --skip-prompt
npx tsx src/bin/pitch.ts list
npx tsx src/bin/pitch.ts get pr-700-default-aas
npx tsx src/bin/pitch.ts resume pr-700-default-aas
npx tsx src/bin/pitch.ts resume pr-700-default-aas --sync
npx tsx src/bin/pitch.ts close pr-700-default-aas
npx tsx src/bin/pitch.ts delete pr-700-default-aas --force
npx tsx src/bin/pitch.ts delete spike-auth -d
npx tsx src/bin/pitch.ts completion zsh > ~/bin/functions/_pitch
```

Top-level verbs are the primary interface. `workspace` is
accepted as a compatibility alias, for example
`npx tsx src/bin/pitch.ts workspace create ...`.

`close` is non-destructive: it tears down the tmux window
and keeps the worktree as a tracked closed record.
`delete` is destructive: it removes the workspace state
file and, when applicable, the worktree. Dirty worktrees
are refused unless `--force` is provided. If
`-d` / `--delete-branch-if-empty` is set, Pitch also deletes the
local branch for non-PR workspaces when it has no commits
outside `base_branch` and no remote-tracking ref.

The `completion zsh` command emits a zsh completion script
with dynamic workspace-name completion for `get`,
`resume`, `close`, and `delete`.

If Pitch is installed as a package, it exposes two
executables:

- `pitch` — direct CLI
- `pitch-mcp` — stdio MCP server

## tmux Status-Right Spike

Pitch includes a tmux `status-right` segment that renders
a simple aggregate of host-side agent state:

```bash
pitch status-right
```

The segment reads agent state collected from Codex and
Claude Code hooks and prints a compact summary such as
`R:3 Q:1 I:2`.
When no active host-side sessions are tracked, it
prints nothing, so you can prepend it to your existing
`status-right` content instead of replacing it:

```tmux
set -g status-right '#(pitch status-right --separator " | ")#H #{window_name} #{pane_current_path}'
```

The current state letters are:

- `R` for running
- `Q` for waiting on human attention
- `I` for idle
- `E` for error

You can also inspect the current cache directly:

```bash
pitch agents
pitch agents --pick
pitch agents-popup
pitch jump SESSION_ID
pitch agent-status
pitch agent-status --json
```

`pitch agents` joins cached agent sessions to live tmux panes by TTY so
you can see where each tracked agent is running.

`pitch agents-popup` opens a native tmux menu with home-row shortcut keys
so you can jump directly to a live agent pane without leaving the current
client.

To record an explicit error state for a session, use:

```bash
pitch agent-error --agent-type claude --session-id SESSION_ID --message "hook failed"
```

This spike currently ignores Pitch workspace state and
uses host-side agent hook state only.

For Codex, `Q` is intentionally conservative. It is only
set for explicit approval or confirmation language in the
final stop message, not for every assistant question.
Claude Code has a richer hook surface, so `Notification`
events map more directly to `Q`. Claude `Stop` messages
that clearly ask for approval or a choice are also treated
as `Q`, which better matches the common Claude workflow of
ending a turn with "Shall I proceed?" or "Let me know
which option you'd like."

### Claude Code Hook Setup

Add host-level Claude hooks in `~/.claude/settings.json`
that invoke Pitch on key lifecycle events:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PITCH_ROOT=/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar /home/rspurgeon/.local/bin/pitch claude-hook"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PITCH_ROOT=/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar /home/rspurgeon/.local/bin/pitch claude-hook"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PITCH_ROOT=/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar /home/rspurgeon/.local/bin/pitch claude-hook"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PITCH_ROOT=/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar /home/rspurgeon/.local/bin/pitch claude-hook"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "PITCH_ROOT=/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar /home/rspurgeon/.local/bin/pitch claude-hook"
          }
        ]
      }
    ]
  }
}
```

## MCP Client Configuration

Pitch usually lives in one checkout, but you use it from a
different project. For example:

- Pitch checkout: `/home/you/dev/rspurgeon/pitch`
- Target project: `/home/you/dev/kong/kongctl`

When adding Pitch to Claude Code, the scope is tied to the
target project where you want Claude to use Pitch, not the
Pitch repository itself.

To make Pitch available only when working in a specific
project, `cd` to that target project and add a local-scoped
server that points at Pitch by absolute path:

```bash
cd /home/you/dev/kong/kongctl
claude mcp add --transport stdio --scope local pitch -- \
  npx tsx /home/you/dev/rspurgeon/pitch/src/index.ts
```

This is the recommended setup for personal use. Claude Code
stores the MCP server under the current project path, so
Pitch will be available in `kongctl` but not in unrelated
projects.

If you want to share the MCP server configuration with
other contributors through version control, `cd` to the
target project and use project scope instead:

```bash
cd /home/you/dev/kong/kongctl
claude mcp add --transport stdio --scope project pitch -- \
  npx tsx /home/you/dev/rspurgeon/pitch/src/index.ts
```

That creates or updates `.mcp.json` in the target project's
root directory.

If you want a user-wide Claude Code configuration that
works across projects, use an absolute path and user
scope:

```bash
claude mcp add --transport stdio --scope user pitch -- \
  npx tsx /absolute/path/to/pitch/src/index.ts
```

Use an absolute path here because user-scoped servers are
not tied to this repository as their working directory.

For other MCP clients that support explicit working
directories, configure Pitch with:

```json
{
  "mcpServers": {
    "pitch": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/pitch"
    }
  }
}
```

## Manual Run

If you want to test the server directly, inspect its
stdio traffic, or send JSON-RPC messages by hand, you can
launch it yourself:

```bash
make start
```

For direct CLI testing from the repository checkout, use:

```bash
npm run cli -- --help
```

For most manual verification, `make ping`,
`make tools-list`, and `make inspect` are usually more
convenient than starting the server yourself.

## Configuration

Pitch reads its configuration from `~/.pitch/config.yaml`.
The file is optional — Pitch starts with sensible defaults
if it's missing. Create it to configure your repos, agents,
and preferences.

### Minimal Example

A basic config to get started with one repo and one agent:

```yaml
defaults:
  repo: myorg/myrepo
  agent: codex
  worktree_root: ~/.local/share/worktrees

repos:
  myorg/myrepo:
    main_worktree: ~/dev/myorg/myrepo
    pane_commands:
      top_right: nvim .
      bottom_right: make build

agents:
  codex:
    type: codex
```

This is enough to start creating workspaces. `defaults.agent`
selects the `codex` entry under `agents`, and that agent
will run with all of its built-in defaults unless you add
custom `args` or `env`. For `myorg/myrepo`, Pitch will
derive `worktree_base` as
`~/.local/share/worktrees/myorg/myrepo` and `tmux_session`
as `myrepo`.

With that config in place, the direct CLI can create a
workspace with:

```bash
npx tsx src/bin/pitch.ts --issue 42
npx tsx src/bin/pitch.ts create --issue 42 --slug fix-bug
```

### Configuration Reference

#### `defaults`

Global defaults applied when a workspace doesn't specify
these values.

| Field | Description | Default |
|---|---|---|
| `repo` | Default GitHub org/repo | none |
| `agent` | Default configured agent name | none |
| `base_branch` | Branch to create workspaces from | `main` |
| `worktree_root` | Root used to derive repo `worktree_base` values | `~/.local/share/worktrees` |

#### `bootstrap_prompts`

Optional prompt templates Pitch sends only when it is
launching a fresh agent process. These templates are not
re-sent on a true session resume.

Supported keys:

| Field | Description |
|---|---|
| `issue` | Template for issue-backed workspaces |
| `pr` | Template for PR-backed workspaces |

Supported template variables:
`{repo}`, `{issue_number}`, `{pr_number}`,
`{workspace_name}`, and `{branch}`.

#### `repos`

Map of GitHub org/repo identifiers to their local paths.
Each repo requires:

| Field | Description |
|---|---|
| `default_agent` | Optional repo-specific default agent name |
| `main_worktree` | Path to the repo's primary checkout |
| `worktree_base` | Optional explicit worktree directory for this repo |
| `tmux_session` | Optional explicit tmux session name for this repo |
| `sandbox` | Optional named outer sandbox preset for this repo |
| `additional_paths` | Optional repo-wide extra directories Pitch translates per agent |
| `bootstrap_prompts` | Optional repo-specific prompt template overrides for `issue` and `pr` |
| `pane_commands` | Optional commands for the `top_right` and `bottom_right` tmux panes |
| `agent_defaults` | Optional repo-wide agent args/env applied to every agent |
| `agent_overrides` | Optional per-repo overrides keyed by configured agent name |

If `worktree_base` is omitted, Pitch derives it as
`{defaults.worktree_root}/{owner}/{repo}`. If `tmux_session`
is omitted, Pitch defaults it to the repo name segment
(`kongctl` for `kong/kongctl`).

If `pane_commands` are configured, Pitch sends them to the
right-hand panes when it creates or recreates the tmux
layout for that workspace. It does not re-run them against
an existing live window.

#### `agents`

Map of selectable agent names to their configuration.
These keys are used everywhere Pitch asks for an agent:
`defaults.agent`, `repos.<repo>.default_agent`,
`create_workspace --agent`, and
`repos.<repo>.agent_overrides`.

Multiple entries can use the same underlying agent type.
For example, `claude-enterprise` and `claude-personal`
can both have `type: claude` with different `env` and
`args` settings.

| Field | Description |
|---|---|
| `type` | `claude`, `codex`, or `opencode` |
| `args` | Ordered CLI arguments appended exactly as written |
| `env` | Environment variables set when launching the agent |

Example with multiple named agents:

```yaml
agents:
  codex:
    type: codex
    args:
      - --sandbox
      - workspace-write
      - --ask-for-approval
      - on-request
    env:
      CODEX_HOME: ~/.codex

  claude-enterprise:
    type: claude
    env:
      CLAUDE_CONFIG_DIR: ~/.claude

  claude-personal:
    type: claude
    args:
      - --model
      - opus
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-personal

  opencode:
    type: opencode
    args:
      - --agent
      - build
    env:
      OPENCODE_CONFIG_DIR: ~/.config/opencode
```

Use `args` whenever you need repeatable flags such as
`--add-dir`, bare flags such as `--search`, or precise
argument ordering.

For attach-mode OpenCode setups, configure `args` with
`attach <url> --dir` and Pitch will supply the workspace
path for `--dir` on both create and resume. When an
OpenCode workspace also needs repo `additional_paths`,
Pitch generates a user-local config file at
`~/.pitch/opencode/{workspace_name}.json` and launches
OpenCode with `OPENCODE_CONFIG` pointing at that file.

#### `sandboxes`

`sandboxes` defines reusable outer sandbox presets. Pitch
currently supports `nono` and wraps agent launches with
`nono run` when a repo selects one of these presets.

| Field | Description |
|---|---|
| `provider` | Must be `nono` |
| `profile` | Optional explicit nono profile name or path |
| `profiles` | Optional per-agent-type profile overrides (`claude`, `codex`, `opencode`) |
| `network_profile` | Optional nono network profile name |
| `capability_elevation` | Optional nono capability-elevation flag |
| `rollback` | Optional nono rollback flag |

Pitch resolves nono profiles in this order:

1. `profiles.<agent-type>`
2. `profile`
3. built-in agent default (`codex`, `claude-code`, or
   `opencode`)

When sandboxing is active, Pitch always passes
`--workdir <workspace>` and `--allow-cwd`.

Example:

```yaml
sandboxes:
  kongctl:
    provider: nono
    profiles:
      codex: /home/rspurgeon/.pitch/nono/profiles/kongctl-codex.json
    capability_elevation: true

repos:
  kong/kongctl:
    sandbox: kongctl
```

#### `repos.<repo>.additional_paths`

`additional_paths` lets you express shared repo
directories once, and Pitch will translate them into
agent-specific launch flags where supported.

Current support:

| Agent type | Behavior |
|---|---|
| `claude` | Adds repeated `--add-dir <path>` flags |
| `codex` | Adds repeated `--add-dir <path>` flags |
| `opencode` | Generates `permission.external_directory` entries in a user-local OpenCode config and sets `OPENCODE_CONFIG` |

For OpenCode, Pitch writes one deterministic file per
workspace outside the repo so checked-out worktrees stay
clean. The generated config contains only the translated
`permission.external_directory` entries, and OpenCode then
merges that config with the normal global and project
config layers. If the selected agent already sets
`OPENCODE_CONFIG`, Pitch first merges that custom config
into the generated workspace file so existing OpenCode
settings are preserved.

#### `repos.<repo>.agent_defaults`

`agent_defaults` lets you attach repo-wide launch behavior
that should apply regardless of which configured agent is
selected for that repo.

| Field | Description |
|---|---|
| `args` | Additional ordered CLI args for every agent in this repo |
| `env` | Additional env vars for every agent in this repo |

#### `repos.<repo>.bootstrap_prompts`

Repo prompt templates override the top-level
`bootstrap_prompts` block for that repo only. Pitch
resolves templates in this order:

1. `repos.<repo>.bootstrap_prompts.<issue|pr>`
2. top-level `bootstrap_prompts.<issue|pr>`
3. Pitch built-in default prompt

#### `repos.<repo>.agent_overrides`

`agent_overrides` lets you attach project-specific launch
behavior to a repo. Override keys must match names under
`agents`, and layer on top of translated
`additional_paths` and `agent_defaults`.

| Field | Description |
|---|---|
| `args` | Additional ordered CLI args for this repo |
| `env` | Additional env vars for this repo |

Example — `kong/kongctl` needs extra writable dirs for
Go and `kongctl` config:

```yaml
repos:
  kong/kongctl:
    default_agent: claude-enterprise
    sandbox: kongctl
    main_worktree: ~/dev/kong/kongctl
    additional_paths:
      - /home/rspurgeon/go
    agent_overrides:
      codex:
        args:
          - --add-dir
          - /home/rspurgeon/.config/kongctl
```

Set up the alternate config directory independently:

```bash
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login
```

Then create workspaces with the named agent entry:

```
create_workspace \
  --issue 42 --agent claude-personal
```

PR-backed workspaces use the same tool with `--pr` instead
of `--issue`:

```
create_workspace \
  --pr 543 --agent claude-enterprise
```

The direct CLI uses the same underlying implementation:

```bash
npx tsx src/bin/pitch.ts --pr 543 --agent claude-enterprise
npx tsx src/bin/pitch.ts create --pr 543 --slug debug-ci --agent claude-enterprise
```

`slug` is optional for issue and PR creation. Without it,
Pitch uses names like `gh-42` or `pr-543`. For PR-backed
workspaces, the slug names the Pitch session and tmux
window. Pitch keeps the real PR head branch checked out
and reuses an existing tracked worktree on that branch
when possible.

## Available Tools

- **ping** — Returns a server status/config summary plus
  runtime identity metadata such as name, version, git
  commit, branch, dirty state, and launch mode.
- **create_workspace** — Creates a workspace from a
  GitHub issue or pull request by provisioning or
  adopting the git worktree, reusing a matching tmux
  window when safe, launching the agent when needed,
  assigning the source GitHub issue or PR to the current
  `gh` user, best-effort setting issue project status to
  `In Progress`, and writing the workspace state record.
- **list_workspaces** — Lists tracked workspaces with
  status, source kind/number, selected agent, and tmux
  location.
- **get_workspace** — Returns the full saved workspace
  record for a specific workspace name.
- **resume_workspace** — Relaunches or resumes the
  coding agent in an existing workspace, including
  previously closed workspaces. Resume never re-sends the
  bootstrap prompt. With `sync: true`, PR workspaces may
  be fast-forwarded to the latest upstream PR head before
  the agent resumes. True resumes also skip GitHub
  lifecycle automation; fresh relaunches may still run
  it.
- **close_workspace** — Closes the tmux window and marks
  the workspace closed. The worktree and state file
  remain so the workspace can be resumed later.
- **delete_workspace** — Deletes a workspace by removing
  its state file and, when applicable, its git worktree.
  Dirty worktrees are refused unless `force` is set.

## Development

```bash
make install       # Install dependencies
make build         # Compile TypeScript to dist/
make clean         # Remove build artifacts
make start         # Launch the MCP server
npm run cli -- --help # Show direct CLI usage
make lint          # Type-check without emitting
make test          # Run unit tests
```

### Testing Tools

```bash
make ping          # Smoke test — MCP handshake + runtime identity
make tools-list    # List all registered MCP tools
make inspect       # Open the MCP Inspector (web UI)
```

`make ping` sends a raw JSON-RPC sequence over stdin
(initialize → ping) and prints the response. Useful for
quick CLI verification and for confirming which checkout,
commit, and launch mode your MCP client is actually
running.

`make inspect` launches the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector),
a web UI for interactively browsing and calling tools.

The tmux integration tests run as part of `make test` when
`tmux` is installed and usable in the local environment.
If `tmux` is unavailable or cannot start a tmux server,
those tests are skipped.
