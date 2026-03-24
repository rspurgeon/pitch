import { describe, expect, it } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  AgentLauncherError,
  buildAgentResumeCommand,
  buildAgentStartCommand,
  claudeLauncher,
  codexLauncher,
  opencodeLauncher,
} from "../agent-launcher.js";

function makeConfig(): PitchConfig {
  return {
    defaults: {
      repo: "kong/kongctl",
      agent: "codex",
      base_branch: "main",
      worktree_root: "~/.local/share/worktrees",
    },
    repos: {
      "kong/kongctl": {
        default_agent: "claude-enterprise",
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        agent_defaults: {
          runtime: undefined,
          args: ["--add-dir", "/home/rspurgeon/go"],
          env: {
            GO_SRC: "/home/rspurgeon/go",
          },
        },
        agent_overrides: {
          codex: {
            runtime: undefined,
            args: [
              "--add-dir",
              "/home/rspurgeon/.config/kongctl",
            ],
            env: {
              KONGCTL_CONFIG_DIR: "/home/rspurgeon/.config/kongctl",
            },
          },
          "claude-personal": {
            runtime: undefined,
            args: [],
            env: {},
          },
          "codex-api": {
            runtime: undefined,
            args: ["--search"],
            env: {
              OPENAI_BASE_URL: "https://api.example.invalid",
            },
          },
        },
      },
    },
    agents: {
      "claude-enterprise": {
        type: "claude",
        runtime: "native",
        args: [
          "--model",
          "sonnet",
          "--permission-mode",
          "bypassPermissions",
        ],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude",
        },
      },
      "claude-personal": {
        type: "claude",
        runtime: "docker",
        args: ["--model", "opus"],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude-personal",
        },
      },
      codex: {
        type: "codex",
        runtime: "native",
        args: [
          "--model",
          "gpt-5.4",
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ],
        env: {
          CODEX_HOME: "~/.codex",
        },
      },
      "codex-api": {
        type: "codex",
        runtime: "native",
        args: [],
        env: {
          CODEX_HOME: "~/.codex-api",
          OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
        },
      },
      opencode: {
        type: "opencode",
        runtime: "native",
        args: ["--agent", "build"],
        env: {
          OPENCODE_CONFIG_DIR: "~/.config/opencode",
        },
      },
      "opencode-attach": {
        type: "opencode",
        runtime: "native",
        args: [
          "attach",
          "http://localhost:4096",
          "--dir",
          ".",
        ],
        env: {
          OPENCODE_SERVER_PASSWORD: "secret",
        },
      },
      "opencode-attach-continue": {
        type: "opencode",
        runtime: "native",
        args: [
          "attach",
          "http://localhost:4096",
          "--continue",
          "--agent",
          "build",
          "--dir",
          ".",
        ],
        env: {
          OPENCODE_SERVER_PASSWORD: "secret",
        },
      },
    },
  };
}

describe("agent launcher", () => {
  it("builds a Claude start command with generated session id", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-enterprise",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.agent_name).toBe("claude-enterprise");
    expect(command.agent_type).toBe("claude");
    expect(command.runtime).toBe("native");
    expect(command.command).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--session-id",
      command.session_id!,
      "--name",
      "gh-565-fix-validation",
    ]);
    expect(command.env).toEqual({
      CLAUDE_CONFIG_DIR: "~/.claude",
    });
  });

  it("builds a Codex start command with layered overrides", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      override_args: [
        "--model",
        "gpt-5.5",
        "--ask-for-approval",
        "never",
        "--cd",
        "/tmp/ignored",
      ],
    });

    expect(command.agent_type).toBe("codex");
    expect(command.runtime).toBe("native");
    expect(command.command).toEqual([
      "codex",
      "--model",
      "gpt-5.4",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--add-dir",
      "/home/rspurgeon/go",
      "--add-dir",
      "/home/rspurgeon/.config/kongctl",
      "--model",
      "gpt-5.5",
      "--ask-for-approval",
      "never",
      "--cd",
      "/tmp/worktree",
    ]);
    expect(command.session_id).toBeUndefined();
    expect(command.env).toEqual({
      CODEX_HOME: "~/.codex",
      GO_SRC: "/home/rspurgeon/go",
      KONGCTL_CONFIG_DIR: "/home/rspurgeon/.config/kongctl",
    });
  });

  it("builds a Claude resume command", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "claude-enterprise",
      session_id: "session-123",
    });

    expect(command.command).toEqual(["claude", "--resume", "session-123"]);
    expect(command.session_id).toBe("session-123");
  });

  it("builds a Codex resume command", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "codex",
      session_id: "session-456",
    });

    expect(command.command).toEqual(["codex", "resume", "session-456"]);
    expect(command.session_id).toBe("session-456");
  });

  it("builds an OpenCode start command in the target worktree", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "opencode",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      override_args: [
        "--model",
        "openrouter/anthropic/claude-sonnet-4",
        "--session",
        "ignored",
      ],
    });

    expect(command.agent_type).toBe("opencode");
    expect(command.runtime).toBe("native");
    expect(command.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "--model",
      "openrouter/anthropic/claude-sonnet-4",
      "/tmp/worktree",
    ]);
    expect(command.session_id).toBeUndefined();
    expect(command.env).toEqual({
      OPENCODE_CONFIG_DIR: "~/.config/opencode",
    });
  });

  it("builds an OpenCode resume command", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "opencode",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "--session",
      "ses_123",
    ]);
    expect(command.session_id).toBe("ses_123");
  });

  it("builds OpenCode attach-mode start and injects the worktree dir", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "opencode-attach",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--dir",
      "/tmp/worktree",
    ]);
    expect(command.env).toEqual({
      OPENCODE_SERVER_PASSWORD: "secret",
    });
  });

  it("builds OpenCode attach-mode resume and preserves the attach target", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "opencode-attach",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--dir",
      "/tmp/worktree",
      "--session",
      "ses_123",
    ]);
    expect(command.env).toEqual({
      OPENCODE_SERVER_PASSWORD: "secret",
    });
  });

  it("strips valueless OpenCode continue flags without dropping following args", () => {
    const config = makeConfig();

    const startCommand = buildAgentStartCommand({
      config,
      agent: "opencode-attach-continue",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(startCommand.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--agent",
      "build",
      "--dir",
      "/tmp/worktree",
    ]);

    const resumeCommand = buildAgentResumeCommand({
      config,
      agent: "opencode-attach-continue",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(resumeCommand.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--agent",
      "build",
      "--dir",
      "/tmp/worktree",
      "--session",
      "ses_123",
    ]);
  });

  it("builds a selected named Claude agent with repo overrides", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-personal",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      session_id: "claude-session",
    });

    expect(command.agent_name).toBe("claude-personal");
    expect(command.agent_type).toBe("claude");
    expect(command.runtime).toBe("docker");
    expect(command.command).toEqual([
      "agent-en-place",
      "claude",
      "--model",
      "opus",
      "--add-dir",
      "/home/rspurgeon/go",
      "--session-id",
      "claude-session",
      "--name",
      "gh-565-fix-validation",
    ]);
    expect(command.env).toEqual({
      CLAUDE_CONFIG_DIR: "~/.claude-personal",
      GO_SRC: "/home/rspurgeon/go",
    });
  });

  it("forwards selected agent env into docker-wrapped Codex commands", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex-api",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      runtime: "docker",
    });

    expect(command.agent_type).toBe("codex");
    expect(command.runtime).toBe("docker");
    expect(command.command).toEqual([
      "agent-en-place",
      "codex",
      "--add-dir",
      "/home/rspurgeon/go",
      "--search",
      "--cd",
      "/tmp/worktree",
    ]);
    expect(command.env).toEqual({
      CODEX_HOME: "~/.codex-api",
      GO_SRC: "/home/rspurgeon/go",
      OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
      OPENAI_BASE_URL: "https://api.example.invalid",
    });
  });

  it("supports explicit runtime overrides", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "claude-enterprise",
      session_id: "resume-123",
      runtime: "docker",
    });

    expect(command.runtime).toBe("docker");
    expect(command.command).toEqual([
      "agent-en-place",
      "claude",
      "--resume",
      "resume-123",
    ]);
  });

  it("does not let Claude overrides replace required workspace flags", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-enterprise",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      session_id: "pitch-session",
      override_args: [
        "--model",
        "opus",
        "--session-id",
        "user-session",
        "--cd",
        "/tmp/ignored",
        "--name",
        "wrong-name",
        "-n",
        "wrong-name-short",
      ],
    });

    expect(command.command).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "opus",
      "--session-id",
      "pitch-session",
      "--name",
      "gh-565-fix-validation",
    ]);
  });

  it("throws when OpenCode is configured with the docker runtime", () => {
    const config = makeConfig();

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "opencode",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
        runtime: "docker",
      }),
    ).toThrow("OpenCode does not support the docker runtime yet");
  });

  it("throws for unknown agent names", () => {
    const config = makeConfig();

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "unknown-agent",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
      }),
    ).toThrow(AgentLauncherError);
  });

  it("throws when the selected named agent is not configured", () => {
    const config = makeConfig();
    delete config.agents["claude-enterprise"];

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "claude-enterprise",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
      }),
    ).toThrow("Agent is not configured: claude-enterprise");
  });

  it("exposes concrete launchers for direct use", () => {
    const config = makeConfig();

    const claude = claudeLauncher.buildResumeCommand({
      config,
      agent: "claude-enterprise",
      session_id: "claude-session",
    });
    const codex = codexLauncher.buildResumeCommand({
      config,
      agent: "codex",
      session_id: "codex-session",
    });
    const opencode = opencodeLauncher.buildResumeCommand({
      config,
      agent: "opencode",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(claude.command).toEqual(["claude", "--resume", "claude-session"]);
    expect(codex.command).toEqual(["codex", "resume", "codex-session"]);
    expect(opencode.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "--session",
      "ses_123",
    ]);
  });
});
