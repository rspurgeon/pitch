# Pitch

Pitch is a local-first workspace orchestration tool for
coding agent sessions. It takes a GitHub issue and sets up
everything a coding agent needs to work: git branch,
worktree, tmux window, and agent process — all tracked and
managed through an MCP server.

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
  agent: claude

repos:
  myorg/myrepo:
    main_worktree: ~/dev/myorg/myrepo
    worktree_base: ~/.local/share/worktrees/myorg/myrepo
    tmux_session: myrepo

agents:
  claude:
    runtime: native
```

This is enough to start creating workspaces. The `claude`
agent will run with all of its built-in defaults — no
`args` or `env` overrides are needed unless you want to
change the agent's default behavior (e.g., pin a model or
set a permission mode).

### Configuration Reference

#### `defaults`

Global defaults applied when a workspace doesn't specify
these values.

| Field | Description | Default |
|---|---|---|
| `repo` | Default GitHub org/repo | none |
| `agent` | Default agent type or profile name | none |
| `base_branch` | Branch to create workspaces from | `main` |

#### `repos`

Map of GitHub org/repo identifiers to their local paths.
Each repo requires:

| Field | Description |
|---|---|
| `main_worktree` | Path to the repo's primary checkout |
| `worktree_base` | Directory where Pitch creates worktrees |
| `tmux_session` | tmux session name for this repo |
| `agent_overrides` | Optional per-repo agent/profile overrides |

#### `agents`

Map of agent names to their configuration. Pitch supports
Claude Code and Codex. Only `runtime` is required — the
`args` and `env` fields are optional and only needed
when you want to override the agent's built-in behavior.

| Field | Description |
|---|---|
| `runtime` | `native` (run directly) or `docker` (via `agent-en-place`) |
| `args` | Ordered CLI arguments appended exactly as written |
| `env` | Environment variables set when launching the agent |

Example with both agents and optional overrides:

```yaml
agents:
  claude:
    runtime: native
    args:
      - --model
      - sonnet
      - --permission-mode
      - bypassPermissions
    env:
      CLAUDE_CONFIG_DIR: ~/.claude

  codex:
    runtime: native
    args:
      - --model
      - gpt-5.4
      - --ask-for-approval
      - on-request
    env:
      CODEX_HOME: ~/.codex
```

Use `args` whenever you need repeatable flags such as
`--add-dir`, bare flags such as `--search`, or precise
argument ordering.

#### `agent_profiles`

Profiles are optional. They extend a base agent with
alternate environment variables or args. This is how
you run the same agent with different accounts or API keys.

| Field | Description |
|---|---|
| `agent` | **(required)** Base agent name to extend |
| `runtime` | Override the base agent's runtime |
| `args` | Additional CLI arguments appended over base |
| `env` | Env var overrides merged over base |

Example — a personal Claude account using a separate
config directory:

```yaml
agent_profiles:
  claude-personal:
    agent: claude
    runtime: native
    env:
      CLAUDE_CONFIG_DIR: ~/.claude-personal
    args:
      - --model
      - opus
```

#### `repos.<repo>.agent_overrides`

`agent_overrides` lets you attach project-specific launch
behavior to a repo without encoding that repo into the
profile name. Override keys can be base agents like
`claude`/`codex` or profile names like `codex-api`.

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
    main_worktree: ~/dev/kong/kongctl
    worktree_base: ~/.local/share/worktrees/kong/kongctl
    tmux_session: kongctl
    agent_overrides:
      codex:
        args:
          - --add-dir
          - /home/rspurgeon/.config/kongctl
          - --add-dir
          - /home/rspurgeon/go
      claude:
        args:
          - --add-dir
          - /home/rspurgeon/go
```

Set up the alternate config directory independently:

```bash
CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login
```

Then create workspaces with the profile:

```
create_workspace \
  --issue 42 --slug fix-bug --agent claude-personal
```

## Available Tools

- **ping** — Returns "pong". Verifies the server is
  running.
- **create_workspace** — Creates a workspace from a
  GitHub issue by provisioning the git worktree, tmux
  window layout, agent launch command, and workspace
  state record.
- **list_workspaces** — Lists tracked workspaces with
  status, issue, agent type, and tmux location.
- **get_workspace** — Returns the full saved workspace
  record for a specific workspace name.
- **close_workspace** — Closes the tmux window and,
  by default, removes the git worktree and workspace
  state file.

## Development

```bash
make install       # Install dependencies
make build         # Compile TypeScript to dist/
make clean         # Remove build artifacts
make start         # Launch the MCP server
make lint          # Type-check without emitting
make test          # Run unit tests
```

### Testing Tools

```bash
make ping          # Smoke test — MCP handshake + ping
make tools-list    # List all registered MCP tools
make inspect       # Open the MCP Inspector (web UI)
```

`make ping` sends a raw JSON-RPC sequence over stdin
(initialize → ping) and prints the response. Useful for
quick CLI verification.

`make inspect` launches the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector),
a web UI for interactively browsing and calling tools.

The tmux integration tests run as part of `make test` when
`tmux` is installed and usable in the local environment.
If `tmux` is unavailable or cannot start a tmux server,
those tests are skipped.
