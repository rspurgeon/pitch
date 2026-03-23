import { describe, expect, it, vi } from "vitest";
import type { BuiltAgentCommand } from "../agent-launcher.js";
import type { PitchConfig } from "../config.js";
import {
  resumeWorkspace,
  ResumeWorkspaceError,
  type ResumeWorkspaceDependencies,
} from "../resume-workspace.js";
import type { WorkspaceRecord } from "../workspace-state.js";

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
      "claude-personal": {
        agent: "claude",
        runtime: "native",
        args: [],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude-personal",
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
        id: "claude-session-1",
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

function makeClaudeResumeCommand(): BuiltAgentCommand {
  return {
    agent_type: "claude",
    runtime: "native",
    command: ["claude", "--resume", "claude-session-1"],
    env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    session_id: "claude-session-1",
  };
}

function makeClaudeStartCommand(): BuiltAgentCommand {
  return {
    agent_type: "claude",
    runtime: "native",
    command: [
      "claude",
      "--model",
      "sonnet",
      "--session-id",
      "claude-session-2",
      "--name",
      "gh-42-fix-bug",
    ],
    env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    session_id: "claude-session-2",
  };
}

function makeDependencies(
  overrides: Partial<ResumeWorkspaceDependencies> = {},
): ResumeWorkspaceDependencies {
  return {
    buildAgentResumeCommand: vi.fn(() => makeClaudeResumeCommand()),
    buildAgentStartCommand: vi.fn(() => makeClaudeStartCommand()),
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
    createTmuxWindow: vi.fn(async () => ({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      window_target: "kongctl:gh-42-fix-bug",
      pane_id: "%1",
    })),
    ensureTmuxSession: vi.fn(async () => ({
      session_name: "kongctl",
      created: false,
    })),
    getTmuxWindowPane: vi.fn(async () => "%1"),
    readWorkspaceRecord: vi.fn(async () => makeWorkspaceRecord()),
    restoreWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    })),
    sendKeysToPane: vi.fn(async () => undefined),
    tmuxWindowExists: vi.fn(async () => true),
    writeWorkspaceRecord: vi.fn(async (workspace: WorkspaceRecord) => workspace),
    now: vi.fn(() => new Date("2026-03-23T04:00:00.000Z")),
    ...overrides,
  };
}

describe("resume workspace", () => {
  it("resumes the most recent session in an active workspace", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    const workspace = await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.buildAgentResumeCommand).toHaveBeenCalledWith({
      config,
      agent: "claude",
      repo: "kong/kongctl",
      session_id: "claude-session-1",
    });
    expect(dependencies.restoreWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
    });
    expect(dependencies.ensureTmuxSession).toHaveBeenCalledWith({
      session_name: "kongctl",
      start_directory: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command:
        "CLAUDE_CONFIG_DIR=~/.claude command -- 'claude' '--resume' 'claude-session-1'",
    });
    expect(workspace).toEqual(
      makeWorkspaceRecord({
        agent_sessions: [
          {
            id: "claude-session-1",
            started_at: "2026-03-22T20:30:00.000Z",
            status: "active",
          },
          {
            id: "claude-session-1",
            started_at: "2026-03-23T04:00:00.000Z",
            status: "active",
          },
        ],
        updated_at: "2026-03-23T04:00:00.000Z",
      }),
    );
  });

  it("launches fresh when there is no resumable session id", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_sessions: [
            {
              id: "pending",
              started_at: "2026-03-22T20:30:00.000Z",
              status: "pending",
            },
          ],
        }),
      ),
    });

    const workspace = await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.buildAgentResumeCommand).not.toHaveBeenCalled();
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "claude",
      repo: "kong/kongctl",
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(workspace.agent_sessions.at(-1)).toEqual({
      id: "claude-session-2",
      started_at: "2026-03-23T04:00:00.000Z",
      status: "active",
    });
  });

  it("recreates the tmux window and layout when the window is missing", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      tmuxWindowExists: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
    });

    await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.createTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      start_directory: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(dependencies.createTmuxLayout).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(dependencies.getTmuxWindowPane).not.toHaveBeenCalled();
  });

  it("starts fresh when overriding to a different agent", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
        agent: "codex",
      },
      config,
      dependencies,
    );

    expect(dependencies.buildAgentResumeCommand).not.toHaveBeenCalled();
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
  });

  it("launches fresh when overriding to a different profile", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
        agent: "claude-personal",
      },
      config,
        dependencies,
      );

    expect(dependencies.buildAgentResumeCommand).not.toHaveBeenCalled();
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "claude-personal",
      repo: "kong/kongctl",
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
  });

  it("errors when the workspace does not exist", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => null),
    });

    await expect(
      resumeWorkspace(
        {
          name: "gh-404-missing",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("Workspace not found: gh-404-missing");
  });

  it("errors when the workspace is not active", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          status: "closed",
        }),
      ),
    });

    await expect(
      resumeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("Workspace is not active: gh-42-fix-bug");
  });

  it("errors when the tmux window is missing", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      createTmuxWindow: vi.fn(async () => {
        throw new Error("window create failed");
      }),
      tmuxWindowExists: vi.fn(async () => false),
    });

    await expect(
      resumeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "Failed to restore tmux window for gh-42-fix-bug: window create failed",
    );
  });

  it("wraps tmux pane lookup failures", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      getTmuxWindowPane: vi.fn(async () => {
        throw new Error("no pane");
      }),
    });

    await expect(
      resumeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("Failed to locate agent pane for gh-42-fix-bug: no pane");
  });

  it("wraps worktree restore failures", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      restoreWorktree: vi.fn(async () => {
        throw new Error("branch missing");
      }),
    });

    await expect(
      resumeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "Failed to restore worktree for gh-42-fix-bug: branch missing",
    );
  });

  it("wraps sendKeysToPane failures", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      sendKeysToPane: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });

    await expect(
      resumeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "Failed to send agent command to tmux pane for gh-42-fix-bug: send failed",
    );
  });

  it("rejects invalid input before reading state", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await expect(
      resumeWorkspace(
        {
          name: "",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(ResumeWorkspaceError);
    expect(dependencies.readWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("errors when the workspace repo is no longer configured", async () => {
    const config = {
      ...makeConfig(),
      repos: {},
    };
    const dependencies = makeDependencies();

    await expect(
      resumeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("Repo is not configured: kong/kongctl");
    expect(dependencies.restoreWorktree).not.toHaveBeenCalled();
  });
});
