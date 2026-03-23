import { describe, expect, it } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  AgentLauncherError,
  buildAgentResumeCommand,
  buildAgentStartCommand,
  claudeLauncher,
  codexLauncher,
} from "../agent-launcher.js";

function makeConfig(): PitchConfig {
  return {
    defaults: {
      repo: "kong/kongctl",
      agent: "codex",
      base_branch: "main",
    },
    repos: {
      "kong/kongctl": {
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        agent_overrides: {
          claude: {
            runtime: undefined,
            args: ["--add-dir", "/home/rspurgeon/go"],
            env: {
              GO_SRC: "/home/rspurgeon/go",
            },
          },
          codex: {
            runtime: undefined,
            args: [
              "--add-dir",
              "/home/rspurgeon/.config/kongctl",
              "--add-dir",
              "/home/rspurgeon/go",
            ],
            env: {
              KONGCTL_CONFIG_DIR: "/home/rspurgeon/.config/kongctl",
            },
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
      claude: {
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
      codex: {
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
    },
    agent_profiles: {
      "claude-personal": {
        agent: "claude",
        runtime: "docker",
        args: ["--model", "opus"],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude-personal",
        },
      },
      "codex-api": {
        agent: "codex",
        runtime: undefined,
        args: [],
        env: {
          CODEX_HOME: "~/.codex-api",
          OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
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
      agent: "claude",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

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
      "/home/rspurgeon/.config/kongctl",
      "--add-dir",
      "/home/rspurgeon/go",
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
      KONGCTL_CONFIG_DIR: "/home/rspurgeon/.config/kongctl",
    });
  });

  it("builds a Claude resume command", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "claude",
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

  it("resolves profiles over the base agent config", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-personal",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      session_id: "claude-session",
    });

    expect(command.agent_type).toBe("claude");
    expect(command.runtime).toBe("docker");
    expect(command.profile_name).toBe("claude-personal");
    expect(command.command).toEqual([
      "agent-en-place",
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
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

  it("forwards profile env into docker-wrapped Codex commands", () => {
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
      "--model",
      "gpt-5.4",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--add-dir",
      "/home/rspurgeon/.config/kongctl",
      "--add-dir",
      "/home/rspurgeon/go",
      "--search",
      "--cd",
      "/tmp/worktree",
    ]);
    expect(command.env).toEqual({
      CODEX_HOME: "~/.codex-api",
      OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
      KONGCTL_CONFIG_DIR: "/home/rspurgeon/.config/kongctl",
      OPENAI_BASE_URL: "https://api.example.invalid",
    });
  });

  it("supports explicit runtime overrides", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "claude",
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
      agent: "claude",
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

  it("throws for unsupported agent names", () => {
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

  it("throws when a profile references an unconfigured base agent", () => {
    const config = makeConfig();
    config.agent_profiles.broken = {
      agent: "claude",
      runtime: undefined,
      args: [],
      env: {},
    };
    delete config.agents["claude"];

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "broken",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
      }),
    ).toThrow("references unconfigured agent: claude");
  });

  it("exposes concrete launchers for direct use", () => {
    const config = makeConfig();

    const claude = claudeLauncher.buildResumeCommand({
      config,
      agent: "claude",
      session_id: "claude-session",
    });
    const codex = codexLauncher.buildResumeCommand({
      config,
      agent: "codex",
      session_id: "codex-session",
    });

    expect(claude.command).toEqual(["claude", "--resume", "claude-session"]);
    expect(codex.command).toEqual(["codex", "resume", "codex-session"]);
  });
});
