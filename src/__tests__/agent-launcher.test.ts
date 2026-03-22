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
      },
    },
    agents: {
      claude: {
        runtime: "native",
        defaults: {
          model: "sonnet",
          permission_mode: "dangerously-skip-permissions",
        },
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude",
        },
      },
      codex: {
        runtime: "native",
        defaults: {
          model: "gpt-5.4",
          sandbox: "workspace-write",
          approval: "on-request",
        },
        env: {
          CODEX_HOME: "~/.codex",
        },
      },
    },
    agent_profiles: {
      "claude-personal": {
        agent: "claude",
        runtime: "docker",
        defaults: {
          model: "opus",
        },
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude-personal",
        },
      },
      "codex-api": {
        agent: "codex",
        defaults: {},
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
    expect(command.command.slice(0, 7)).toEqual([
      "claude",
      "--session-id",
      command.session_id!,
      "--cd",
      "/tmp/worktree",
      "--name",
      "gh-565-fix-validation",
    ]);
    expect(command.command).toContain("--model");
    expect(command.command).toContain("sonnet");
    expect(command.env).toEqual({
      CLAUDE_CONFIG_DIR: "~/.claude",
    });
  });

  it("builds a Codex start command with layered overrides", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      overrides: {
        model: "gpt-5.5",
        approval: "never",
      },
    });

    expect(command.agent_type).toBe("codex");
    expect(command.runtime).toBe("native");
    expect(command.command).toEqual([
      "codex",
      "--cd",
      "/tmp/worktree",
      "--model",
      "gpt-5.5",
      "--sandbox",
      "workspace-write",
      "--approval",
      "never",
    ]);
    expect(command.session_id).toBeUndefined();
    expect(command.env).toEqual({
      CODEX_HOME: "~/.codex",
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
      "claude",
      "--session-id",
      "claude-session",
      "--cd",
      "/tmp/worktree",
      "--name",
      "gh-565-fix-validation",
      "--model",
      "opus",
      "--permission_mode",
      "dangerously-skip-permissions",
    ]);
    expect(command.env).toEqual({
      CLAUDE_CONFIG_DIR: "~/.claude-personal",
    });
  });

  it("forwards profile env into docker-wrapped Codex commands", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex-api",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      runtime: "docker",
    });

    expect(command.agent_type).toBe("codex");
    expect(command.runtime).toBe("docker");
    expect(command.command).toEqual([
      "agent-en-place",
      "codex",
      "codex",
      "--cd",
      "/tmp/worktree",
      "--model",
      "gpt-5.4",
      "--sandbox",
      "workspace-write",
      "--approval",
      "on-request",
    ]);
    expect(command.env).toEqual({
      CODEX_HOME: "~/.codex-api",
      OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
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
      "claude",
      "--resume",
      "resume-123",
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
      agent: "claude-alt",
      defaults: {},
      env: {},
    };

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "broken",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
      }),
    ).toThrow(AgentLauncherError);
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
