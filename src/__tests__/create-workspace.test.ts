import { describe, expect, it, vi } from "vitest";
import type { BuiltAgentCommand } from "../agent-launcher.js";
import type { PitchConfig } from "../config.js";
import {
  createWorkspace,
  CreateWorkspaceError,
  type CreateWorkspaceDependencies,
} from "../create-workspace.js";
import type { WorkspaceRecord } from "../workspace-state.js";

function makeConfig(): PitchConfig {
  return {
    defaults: {
      repo: "kong/kongctl",
      agent: "claude",
      base_branch: "main",
    },
    repos: {
      "kong/kongctl": {
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        agent_overrides: {},
      },
    },
    agents: {
      claude: {
        runtime: "native",
        args: ["--model", "sonnet"],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude",
        },
      },
      codex: {
        runtime: "native",
        args: ["--model", "gpt-5.4"],
        env: {
          CODEX_HOME: "~/.codex",
        },
      },
    },
    agent_profiles: {
      "codex-api": {
        agent: "codex",
        runtime: "docker",
        args: [],
        env: {
          CODEX_HOME: "~/.codex-api",
          OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
        },
      },
    },
  };
}

function makeWorkspaceRecord(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    name: "gh-42-fix-bug",
    repo: "kong/kongctl",
    issue: 42,
    branch: "gh-42-fix-bug",
    worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    base_branch: "main",
    tmux_session: "kongctl",
    tmux_window: "gh-42-fix-bug",
    agent_type: "claude",
    agent_profile: null,
    agent_runtime: "native",
    agent_env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    agent_sessions: [
      {
        id: "claude-session",
        started_at: "2026-03-22T20:30:00.000Z",
        status: "active",
      },
    ],
    status: "active",
    created_at: "2026-03-22T20:30:00.000Z",
    updated_at: "2026-03-22T20:30:00.000Z",
    ...overrides,
  };
}

function makeClaudeCommand(): BuiltAgentCommand {
  return {
    agent_type: "claude",
    runtime: "native",
    command: [
      "claude",
      "--model",
      "opus",
      "--session-id",
      "claude-session",
      "--name",
      "gh-42-fix-bug",
    ],
    env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    session_id: "claude-session",
  };
}

function makeCodexCommand(): BuiltAgentCommand {
  return {
    agent_type: "codex",
    runtime: "docker",
    command: [
      "agent-en-place",
      "codex",
      "--model",
      "gpt-5.4",
      "--cd",
      "/tmp/worktrees/gh-42-fix-bug",
    ],
    env: {
      CODEX_HOME: "~/.codex-api",
      OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
    },
    profile_name: "codex-api",
  };
}

function makeDependencies(
  overrides: Partial<CreateWorkspaceDependencies> = {},
): CreateWorkspaceDependencies {
  return {
    readWorkspaceRecord: vi.fn(async () => null),
    writeWorkspaceRecord: vi.fn(async (workspace: WorkspaceRecord) => workspace),
    deleteWorkspaceRecord: vi.fn(async () => true),
    createWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    })),
    removeWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    })),
    ensureTmuxSession: vi.fn(async () => ({
      session_name: "kongctl",
      created: true,
    })),
    createTmuxWindow: vi.fn(async () => ({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      window_target: "kongctl:gh-42-fix-bug",
      pane_id: "%1",
    })),
    killTmuxWindow: vi.fn(async () => true),
    createTmuxLayout: vi.fn(async () => ({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      window_target: "kongctl:gh-42-fix-bug",
      panes: {
        agent_pane_id: "%1",
        top_right_pane_id: "%2",
        bottom_right_pane_id: "%3",
      },
    })),
    sendKeysToPane: vi.fn(async () => undefined),
    buildAgentStartCommand: vi.fn(() => makeClaudeCommand()),
    now: vi.fn(() => new Date("2026-03-22T20:30:00.000Z")),
    ...overrides,
  };
}

describe("create workspace", () => {
  it("creates a Claude workspace record and launches the agent pane", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    const workspace = await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        model: "opus",
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(makeWorkspaceRecord());
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "claude",
      repo: "kong/kongctl",
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      override_args: ["--model", "opus"],
      runtime: undefined,
    });
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command:
        "CLAUDE_CONFIG_DIR=~/.claude command -- 'claude' '--model' 'opus' " +
        "'--session-id' 'claude-session' '--name' 'gh-42-fix-bug'",
    });

    const writeCallOrder = vi.mocked(
      dependencies.writeWorkspaceRecord,
    ).mock.invocationCallOrder[0];
    const sendCallOrder = vi.mocked(
      dependencies.sendKeysToPane,
    ).mock.invocationCallOrder[0];
    expect(writeCallOrder).toBeLessThan(sendCallOrder);
  });

  it("stores a pending Codex session and preserves shell-expanded env vars", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      buildAgentStartCommand: vi.fn(() => makeCodexCommand()),
    });

    const workspace = await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        agent: "codex-api",
        runtime: "docker",
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(
      makeWorkspaceRecord({
        agent_type: "codex",
        agent_profile: "codex-api",
        agent_runtime: "docker",
        agent_env: {
          CODEX_HOME: "~/.codex-api",
          OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
        },
        agent_sessions: [
          {
            id: "pending",
            started_at: "2026-03-22T20:30:00.000Z",
            status: "pending",
          },
        ],
      }),
    );
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command:
        "CODEX_HOME=~/.codex-api OPENAI_API_KEY=${OPENAI_API_KEY_SECONDARY} " +
        "command -- 'agent-en-place' 'codex' '--model' 'gpt-5.4' '--cd' " +
        "'/tmp/worktrees/gh-42-fix-bug'",
    });
  });

  it("rejects invalid slugs before any side effects", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await expect(
      createWorkspace(
        {
          issue: 42,
          slug: "Fix Bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(CreateWorkspaceError);
    expect(dependencies.readWorkspaceRecord).not.toHaveBeenCalled();
    expect(dependencies.createWorktree).not.toHaveBeenCalled();
  });

  it("fails when a workspace record already exists", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => makeWorkspaceRecord()),
    });

    await expect(
      createWorkspace(
        {
          issue: 42,
          slug: "fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("Workspace already exists: gh-42-fix-bug");
    expect(dependencies.createWorktree).not.toHaveBeenCalled();
  });

  it("rolls back the worktree when tmux setup fails", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      createTmuxWindow: vi.fn(async () => {
        throw new Error("tmux window failed");
      }),
    });

    await expect(
      createWorkspace(
        {
          issue: 42,
          slug: "fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("tmux window failed");
    expect(dependencies.removeWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
    });
    expect(dependencies.killTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("cleans up state, tmux window, and worktree when agent launch fails", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      sendKeysToPane: vi.fn(async () => {
        throw new Error("agent launch failed");
      }),
    });

    await expect(
      createWorkspace(
        {
          issue: 42,
          slug: "fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("agent launch failed");
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
    expect(dependencies.killTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
    });
    expect(dependencies.removeWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
    });
  });
});
