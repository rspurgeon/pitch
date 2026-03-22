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

## Run

```bash
make start
```

This launches the Pitch MCP server on stdio. Connect to it
from any MCP-compatible client (e.g., Claude Code).

## MCP Client Configuration

To use Pitch with Claude Code:

```bash
claude mcp add pitch -- npx tsx src/index.ts
```

Or add it manually to your MCP client config:

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
`defaults` or `env` overrides are needed unless you want to
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

#### `agents`

Map of agent names to their configuration. Pitch supports
Claude Code and Codex. Only `runtime` is required — the
`defaults` and `env` fields are optional and only needed
when you want to override the agent's built-in behavior.

| Field | Description |
|---|---|
| `runtime` | `native` (run directly) or `docker` (via `agent-en-place`) |
| `defaults` | Key-value map of CLI flags passed to the agent |
| `env` | Environment variables set when launching the agent |

Example with both agents and optional overrides:

```yaml
agents:
  claude:
    runtime: native
    defaults:
      model: sonnet
      permission_mode: dangerously-skip-permissions
    env:
      CLAUDE_CONFIG_DIR: ~/.claude

  codex:
    runtime: native
    defaults:
      model: gpt-5.4
      approval: on-request
    env:
      CODEX_HOME: ~/.codex
```

#### `agent_profiles`

Profiles are optional. They extend a base agent with
alternate environment variables or defaults. This is how
you run the same agent with different accounts or API keys.

| Field | Description |
|---|---|
| `agent` | **(required)** Base agent name to extend |
| `runtime` | Override the base agent's runtime |
| `defaults` | CLI flag overrides merged over base |
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
    defaults:
      model: opus
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
