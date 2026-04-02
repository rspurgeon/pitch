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
npx tsx src/bin/pitch.ts create --pr 700 --slug default-aas --skip-prompt
npx tsx src/bin/pitch.ts list
npx tsx src/bin/pitch.ts get pr-700-default-aas
npx tsx src/bin/pitch.ts resume pr-700-default-aas
npx tsx src/bin/pitch.ts close pr-700-default-aas
npx tsx src/bin/pitch.ts delete pr-700-default-aas
npx tsx src/bin/pitch.ts completion zsh > ~/bin/functions/_pitch
```

Top-level verbs are the primary interface. `workspace` is
accepted as a compatibility alias, for example
`npx tsx src/bin/pitch.ts workspace create ...`.
`delete` is accepted as an alias for `close`.

The `completion zsh` command emits a zsh completion script
with dynamic workspace-name completion for `get`,
`resume`, `close`, and `delete`.

If Pitch is installed as a package, it exposes two
executables:

- `pitch` — direct CLI
- `pitch-mcp` — stdio MCP server

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

agents:
  codex:
    type: codex
    runtime: native
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
| `additional_paths` | Optional repo-wide extra directories Pitch translates per agent |
| `bootstrap_prompts` | Optional repo-specific prompt template overrides for `issue` and `pr` |
| `agent_defaults` | Optional repo-wide agent args/env/runtime applied to every agent |
| `agent_overrides` | Optional per-repo overrides keyed by configured agent name |

If `worktree_base` is omitted, Pitch derives it as
`{defaults.worktree_root}/{owner}/{repo}`. If `tmux_session`
is omitted, Pitch defaults it to the repo name segment
(`kongctl` for `kong/kongctl`).

#### `agents`

Map of selectable agent names to their configuration.
These keys are used everywhere Pitch asks for an agent:
`defaults.agent`, `repos.<repo>.default_agent`,
`create_workspace --agent`, and
`repos.<repo>.agent_overrides`.

Multiple entries can use the same underlying agent type.
For example, `claude-enterprise` and `claude-personal`
can both have `type: claude` with different `env`,
`args`, or `runtime` settings.

| Field | Description |
|---|---|
| `type` | `claude`, `codex`, or `opencode` |
| `runtime` | `native` (run directly) or `docker` (via `agent-en-place` for Claude/Codex) |
| `args` | Ordered CLI arguments appended exactly as written |
| `env` | Environment variables set when launching the agent |

Example with multiple named agents:

```yaml
agents:
  codex:
    type: codex
    runtime: native
    args:
      - --sandbox
      - workspace-write
      - --ask-for-approval
      - on-request
    env:
      CODEX_HOME: ~/.codex

  claude-enterprise:
    type: claude
    runtime: native
    env:
      CLAUDE_CONFIG_DIR: ~/.claude

  claude-personal:
    type: claude
    runtime: native
    args:
      - --model
      - opus
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-personal

  opencode:
    type: opencode
    runtime: native
    args:
      - --agent
      - build
    env:
      OPENCODE_CONFIG_DIR: ~/.config/opencode
```

Use `args` whenever you need repeatable flags such as
`--add-dir`, bare flags such as `--search`, or precise
argument ordering.

OpenCode currently supports the `native` runtime only.
For attach-mode OpenCode setups, configure `args` with
`attach <url> --dir` and Pitch will supply the workspace
path for `--dir` on both create and resume. When an
OpenCode workspace also needs repo `additional_paths`,
Pitch generates a user-local config file at
`~/.pitch/opencode/{workspace_name}.json` and launches
OpenCode with `OPENCODE_CONFIG` pointing at that file.

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
| `runtime` | Optional repo-wide runtime override |
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
| `runtime` | Optional repo-specific runtime override |
| `args` | Additional ordered CLI args for this repo |
| `env` | Additional env vars for this repo |

Example — `kong/kongctl` needs extra writable dirs for
Go and `kongctl` config:

```yaml
repos:
  kong/kongctl:
    default_agent: claude-enterprise
    main_worktree: ~/dev/kong/kongctl
    additional_paths:
      - /home/rspurgeon/go
    agent_overrides:
      claude-enterprise:
        runtime: docker
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
  --issue 42 --slug fix-bug --agent claude-personal
```

PR-backed workspaces use the same tool with `--pr` instead
of `--issue`:

```
create_workspace \
  --pr 543 --slug debug-ci --agent claude-enterprise
```

The direct CLI uses the same underlying implementation:

```bash
npx tsx src/bin/pitch.ts create --pr 543 --slug debug-ci --agent claude-enterprise
```

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
  coding agent in an existing active workspace. True
  resumes do not re-send bootstrap prompts or GitHub
  lifecycle automation; fresh relaunches do.
- **close_workspace** — Closes the tmux window and,
  by default, removes the git worktree and workspace
  state file.

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
