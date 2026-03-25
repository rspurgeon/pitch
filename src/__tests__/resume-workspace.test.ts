import { describe, expect, it, vi } from "vitest";
import type { BuiltAgentCommand } from "../agent-launcher.js";
import type { PitchConfig } from "../config.js";
import {
  resumeWorkspace,
  ResumeWorkspaceError,
  type ResumeWorkspaceDependencies,
} from "../resume-workspace.js";
import type { TmuxPaneInfo } from "../tmux.js";
import type { WorkspaceRecord } from "../workspace-state.js";

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
        additional_paths: [],
        agent_defaults: {
          runtime: undefined,
          args: [],
          env: {},
        },
        agent_overrides: {},
      },
    },
    agents: {
      "claude-enterprise": {
        type: "claude",
        runtime: "native",
        args: ["--model", "sonnet"],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude",
        },
      },
      "claude-personal": {
        type: "claude",
        runtime: "native",
        args: [],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude-personal",
        },
      },
      codex: {
        type: "codex",
        runtime: "native",
        args: ["--model", "gpt-5.4"],
        env: {
          CODEX_HOME: "~/.codex",
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
    },
  };
}

function makeWorkspaceRecord(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    name: "gh-42-fix-bug",
    repo: "kong/kongctl",
    source_kind: "issue",
    source_number: 42,
    branch: "gh-42-fix-bug",
    worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    base_branch: "main",
    tmux_session: "kongctl",
    tmux_window: "gh-42-fix-bug",
    agent_name: "claude-enterprise",
    agent_type: "claude",
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
    agent_name: "claude-enterprise",
    agent_type: "claude",
    runtime: "native",
    command: ["claude", "--resume", "claude-session-1"],
    env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    session_id: "claude-session-1",
    warnings: [],
  };
}

function makeClaudeStartCommand(): BuiltAgentCommand {
  return {
    agent_name: "claude-enterprise",
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
    warnings: [],
  };
}

function makeOpencodeResumeCommand(): BuiltAgentCommand {
  return {
    agent_name: "opencode",
    agent_type: "opencode",
    runtime: "native",
    command: ["opencode", "--session", "ses_123"],
    env: {
      OPENCODE_CONFIG_DIR: "~/.config/opencode",
    },
    session_id: "ses_123",
    warnings: [],
  };
}

function makeOpencodeStartCommand(): BuiltAgentCommand {
  return {
    agent_name: "opencode",
    agent_type: "opencode",
    runtime: "native",
    command: ["opencode", "--agent", "build", "/tmp/worktrees/gh-42-fix-bug"],
    env: {
      OPENCODE_CONFIG_DIR: "~/.config/opencode",
    },
    warnings: [],
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
    findCodexSessionForWorkspace: vi.fn(async () => null),
    findOpencodeSessionForWorkspace: vi.fn(async () => null),
    getTmuxWindowPaneInfo: vi.fn(
      async () =>
        ({
          pane_id: "%1",
          current_command: "claude",
          current_path: "/tmp/worktrees/gh-42-fix-bug",
        }) satisfies TmuxPaneInfo,
    ),
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
      agent: "claude-enterprise",
      repo: "kong/kongctl",
      session_id: "claude-session-1",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(dependencies.restoreWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
      branch: "gh-42-fix-bug",
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
      agent: "claude-enterprise",
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

  it("does not launch a second agent when the pane already has a compatible running agent", async () => {
    const config = makeConfig();
    const originalWorkspace = makeWorkspaceRecord({
      agent_sessions: [],
    });
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => originalWorkspace),
    });

    const workspace = await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.buildAgentResumeCommand).not.toHaveBeenCalled();
    expect(dependencies.buildAgentStartCommand).not.toHaveBeenCalled();
    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
    expect(workspace).toEqual(originalWorkspace);
  });

  it("backfills a pending Codex session from the local session store before resuming", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_name: "codex",
          agent_type: "codex",
          agent_env: {
            CODEX_HOME: "~/.codex",
          },
          agent_sessions: [
            {
              id: "pending",
              started_at: "2026-03-23T04:00:00.000Z",
              status: "pending",
            },
          ],
        }),
      ),
      buildAgentResumeCommand: vi.fn(() => ({
        agent_name: "codex",
        agent_type: "codex",
        runtime: "native",
        command: ["codex", "resume", "codex-session-1"],
        env: {
          CODEX_HOME: "~/.codex",
        },
        session_id: "codex-session-1",
        warnings: [],
      }) satisfies BuiltAgentCommand),
      findCodexSessionForWorkspace: vi.fn(async () => ({
        id: "codex-session-1",
        timestamp: "2026-03-23T04:00:05.000Z",
        cwd: "/tmp/worktrees/gh-42-fix-bug",
        file_path: "/tmp/.codex/sessions/2026/03/23/rollout.jsonl",
      })),
    });

    const workspace = await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.findCodexSessionForWorkspace).toHaveBeenCalledWith({
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      started_at: "2026-03-23T04:00:00.000Z",
      agent_env: {
        CODEX_HOME: "~/.codex",
      },
    });
    expect(dependencies.buildAgentResumeCommand).toHaveBeenCalledWith({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      session_id: "codex-session-1",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(workspace.agent_sessions).toEqual([
      {
        id: "codex-session-1",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "active",
      },
      {
        id: "codex-session-1",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "active",
      },
    ]);
  });

  it("does not reuse an older session when the latest Codex session is pending", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_name: "codex",
          agent_type: "codex",
          agent_env: {
            CODEX_HOME: "~/.codex",
          },
          agent_sessions: [
            {
              id: "codex-session-old",
              started_at: "2026-03-22T20:30:00.000Z",
              status: "active",
            },
            {
              id: "pending",
              started_at: "2026-03-23T04:00:00.000Z",
              status: "pending",
            },
          ],
        }),
      ),
      buildAgentResumeCommand: vi.fn(() => ({
        agent_name: "codex",
        agent_type: "codex",
        runtime: "native",
        command: ["codex", "resume", "codex-session-new"],
        env: {
          CODEX_HOME: "~/.codex",
        },
        session_id: "codex-session-new",
        warnings: [],
      }) satisfies BuiltAgentCommand),
      findCodexSessionForWorkspace: vi.fn(async () => ({
        id: "codex-session-new",
        timestamp: "2026-03-23T04:00:05.000Z",
        cwd: "/tmp/worktrees/gh-42-fix-bug",
        file_path: "/tmp/.codex/sessions/2026/03/23/rollout.jsonl",
      })),
    });

    const workspace = await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.findCodexSessionForWorkspace).toHaveBeenCalled();
    expect(dependencies.buildAgentResumeCommand).toHaveBeenCalledWith({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      session_id: "codex-session-new",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(workspace.agent_sessions).toEqual([
      {
        id: "codex-session-old",
        started_at: "2026-03-22T20:30:00.000Z",
        status: "active",
      },
      {
        id: "codex-session-new",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "active",
      },
      {
        id: "codex-session-new",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "active",
      },
    ]);
  });

  it("falls back to a fresh Codex launch when session store lookup fails", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_name: "codex",
          agent_type: "codex",
          agent_env: {
            CODEX_HOME: "~/.codex",
          },
          agent_sessions: [
            {
              id: "pending",
              started_at: "2026-03-23T04:00:00.000Z",
              status: "pending",
            },
          ],
        }),
      ),
      buildAgentStartCommand: vi.fn(() => ({
        agent_name: "codex",
        agent_type: "codex",
        runtime: "native",
        command: ["codex", "--cd", "/tmp/worktrees/gh-42-fix-bug"],
        env: {
          CODEX_HOME: "~/.codex",
        },
        warnings: [],
      }) satisfies BuiltAgentCommand),
      findCodexSessionForWorkspace: vi.fn(async () => {
        throw new Error("session store unavailable");
      }),
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
      agent: "codex",
      repo: "kong/kongctl",
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(workspace.agent_sessions).toEqual([
      {
        id: "pending",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "pending",
      },
      {
        id: "pending",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "pending",
      },
    ]);
  });

  it("skips native Codex session lookup for docker Codex workspaces", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_name: "codex",
          agent_type: "codex",
          agent_runtime: "docker",
          agent_env: {
            CODEX_HOME: "~/.codex-docker",
          },
          agent_sessions: [
            {
              id: "pending",
              started_at: "2026-03-23T04:00:00.000Z",
              status: "pending",
            },
          ],
        }),
      ),
      buildAgentStartCommand: vi.fn(() => ({
        agent_name: "codex",
        agent_type: "codex",
        runtime: "docker",
        command: ["agent-en-place", "codex"],
        env: {
          CODEX_HOME: "~/.codex-docker",
        },
        warnings: [],
      }) satisfies BuiltAgentCommand),
    });

    await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.findCodexSessionForWorkspace).not.toHaveBeenCalled();
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
  });

  it("uses the restored worktree path for recovery and state updates", async () => {
    const config = makeConfig();
    const restoredWorktreePath = "/tmp/restored/gh-42-fix-bug";
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          worktree_path: "/tmp/stale/gh-42-fix-bug",
        }),
      ),
      restoreWorktree: vi.fn(async () => ({
        branch: "gh-42-fix-bug",
        worktree_path: restoredWorktreePath,
      })),
      tmuxWindowExists: vi.fn(async () => false),
    });

    const workspace = await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.ensureTmuxSession).toHaveBeenCalledWith({
      session_name: "kongctl",
      start_directory: restoredWorktreePath,
    });
    expect(dependencies.createTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      start_directory: restoredWorktreePath,
    });
    expect(dependencies.createTmuxLayout).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      worktree_path: restoredWorktreePath,
    });
    expect(workspace.worktree_path).toBe(restoredWorktreePath);
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
    expect(dependencies.findCodexSessionForWorkspace).not.toHaveBeenCalled();
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

  it("backfills a pending OpenCode session and resumes it", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_name: "opencode",
          agent_type: "opencode",
          agent_env: {
            OPENCODE_CONFIG_DIR: "~/.config/opencode",
          },
          agent_sessions: [
            {
              id: "pending",
              started_at: "2026-03-22T20:30:00.000Z",
              status: "pending",
            },
          ],
        }),
      ),
      buildAgentResumeCommand: vi.fn(() => makeOpencodeResumeCommand()),
      buildAgentStartCommand: vi.fn(() => makeOpencodeStartCommand()),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%1",
            current_command: "opencode",
            current_path: "/tmp/worktrees/gh-42-fix-bug",
          }) satisfies TmuxPaneInfo,
      ),
      findOpencodeSessionForWorkspace: vi.fn(async () => ({
        id: "ses_123",
        directory: "/tmp/worktrees/gh-42-fix-bug",
        created_at: "2026-03-22T20:31:00.000Z",
        file_path: "/tmp/opencode-session.json",
      })),
    });

    const workspace = await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.findOpencodeSessionForWorkspace).toHaveBeenCalledWith({
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      started_at: "2026-03-22T20:30:00.000Z",
      agent_env: {
        OPENCODE_CONFIG_DIR: "~/.config/opencode",
      },
    });
    expect(dependencies.buildAgentResumeCommand).toHaveBeenCalledWith({
      config,
      agent: "opencode",
      repo: "kong/kongctl",
      session_id: "ses_123",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(workspace.agent_sessions).toEqual([
      {
        id: "ses_123",
        started_at: "2026-03-22T20:30:00.000Z",
        status: "active",
      },
      {
        id: "ses_123",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "active",
      },
    ]);
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

  it("wraps command formatting failures separately from tmux send failures", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      buildAgentResumeCommand: vi.fn(() => ({
        ...makeClaudeResumeCommand(),
        env: {
          "BAD-NAME": "value",
        },
      })),
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
      "Failed to format agent command for gh-42-fix-bug: Invalid environment variable name: BAD-NAME",
    );
    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
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
