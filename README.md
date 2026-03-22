# Pitch

Pitch is a local-first workspace orchestration tool for coding agent sessions. It takes a GitHub issue and sets up everything a coding agent needs to work: git branch, worktree, tmux window, and agent process — all tracked and managed through an MCP server.

See [docs/design.md](docs/design.md) for the full design document.

## Prerequisites

- [mise](https://mise.jdx.dev/) — manages required tool versions

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

This launches the Pitch MCP server on stdio. Connect to it from any MCP-compatible client (e.g., Claude Code).

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

## Available Tools

- **ping** — Returns "pong". Used to verify the server is running.

## Development

```bash
make install       # Install dependencies
make build         # Compile TypeScript to dist/
make clean         # Remove build artifacts
make start         # Launch the MCP server
make lint          # Type-check without emitting
```

### Testing Tools

```bash
make ping          # Smoke test — MCP handshake + ping tool call via stdin
make inspect       # Open the MCP Inspector (interactive web UI)
```

`make ping` sends a raw JSON-RPC sequence over stdin (initialize → ping) and prints the responses. Useful for quick CLI verification.

`make inspect` launches the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), a web UI for interactively browsing and calling tools.
