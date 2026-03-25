import { describe, expect, it, vi } from "vitest";
import type { BuiltAgentCommand } from "../agent-launcher.js";
import type { PitchConfig } from "../config.js";
import {
  createWorkspace,
  CreateWorkspaceError,
  type CreateWorkspaceDependencies,
} from "../create-workspace.js";
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
      codex: {
        type: "codex",
        runtime: "native",
        args: ["--model", "gpt-5.4"],
        env: {
          CODEX_HOME: "~/.codex",
        },
      },
      "codex-api": {
        type: "codex",
        runtime: "docker",
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
    agent_name: "claude-enterprise",
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
    warnings: [],
  };
}

function makeCodexCommand(): BuiltAgentCommand {
  return {
    agent_name: "codex-api",
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
    warnings: [],
  };
}

function makeOpencodeCommand(): BuiltAgentCommand {
  return {
    agent_name: "opencode",
    agent_type: "opencode",
    runtime: "native",
    command: [
      "opencode",
      "--agent",
      "build",
      "/tmp/worktrees/gh-42-fix-bug",
    ],
    env: {
      OPENCODE_CONFIG_DIR: "~/.config/opencode",
    },
    warnings: [],
  };
}

function makeDependencies(
  overrides: Partial<CreateWorkspaceDependencies> = {},
): CreateWorkspaceDependencies {
  return {
    readWorkspaceRecord: vi.fn(async () => null),
    listWorkspaceRecords: vi.fn(async () => []),
    writeWorkspaceRecord: vi.fn(async (workspace: WorkspaceRecord) => workspace),
    deleteWorkspaceRecord: vi.fn(async () => true),
    ensureWorkspaceWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      adopted: false,
    })),
    fetchGitRef: vi.fn(async () => "refs/pitch/pr/123/head"),
    removeWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    })),
    readPullRequest: vi.fn(async () => ({
      number: 123,
      title: "Example PR",
      state: "OPEN",
      base_ref_name: "main",
      head_ref_name: "feature/example",
      head_ref_oid: "abc123",
      is_cross_repository: false,
      url: "https://github.com/example/repo/pull/123",
    })),
    ensureTmuxSession: vi.fn(async () => ({
      session_name: "kongctl",
      created: true,
    })),
    tmuxWindowExists: vi.fn(async () => false),
    createTmuxWindow: vi.fn(async () => ({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
      window_target: "kongctl:gh-42-fix-bug",
      pane_id: "%1",
    })),
    getTmuxWindowPaneInfo: vi.fn(
      async () =>
        ({
          pane_id: "%1",
          current_command: "zsh",
          current_path: "/tmp/worktrees/gh-42-fix-bug",
        }) satisfies TmuxPaneInfo,
    ),
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
      agent: "claude-enterprise",
      repo: "kong/kongctl",
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      override_args: ["--model", "opus"],
      runtime: undefined,
    });
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
      branch: "gh-42-fix-bug",
      start_point: "main",
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

  it("creates a PR-backed workspace from the PR head branch", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      ensureWorkspaceWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-123-sync-pr",
        adopted: false,
      })),
      buildAgentStartCommand: vi.fn(
        (): BuiltAgentCommand => ({
          agent_name: "claude-enterprise",
          agent_type: "claude",
          runtime: "native",
          command: [
            "claude",
            "--model",
            "sonnet",
            "--session-id",
            "claude-session",
            "--name",
            "pr-123-sync-pr",
          ],
          env: {
            CLAUDE_CONFIG_DIR: "~/.claude",
          },
          session_id: "claude-session",
          warnings: [],
        }),
      ),
    });

    const workspace = await createWorkspace(
      {
        pr: 123,
        slug: "sync-pr",
      },
      config,
      dependencies,
    );

    expect(dependencies.readPullRequest).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      pr_number: 123,
    });
    expect(dependencies.listWorkspaceRecords).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      status: "all",
    });
    expect(dependencies.fetchGitRef).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      remote: "origin",
      source_ref: "refs/pull/123/head",
      destination_ref: "refs/pitch/pr/123/head",
    });
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "pr-123-sync-pr",
      branch: "feature/example",
      start_point: "refs/pitch/pr/123/head",
    });
    expect(workspace).toEqual(
      makeWorkspaceRecord({
        name: "pr-123-sync-pr",
        source_kind: "pr",
        source_number: 123,
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-123-sync-pr",
        tmux_window: "pr-123-sync-pr",
      }),
    );
  });

  it("rejects a second tracked workspace for the same PR", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      listWorkspaceRecords: vi.fn(async () => [
        makeWorkspaceRecord({
          name: "pr-123-existing",
          source_kind: "pr",
          source_number: 123,
          branch: "feature/example",
          worktree_path: "/tmp/worktrees/pr-123-existing",
          tmux_window: "pr-123-existing",
        }),
      ]),
    });

    await expect(
      createWorkspace(
        {
          pr: 123,
          slug: "other-slug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "PR #123 already has a tracked workspace: pr-123-existing",
    );
    expect(dependencies.fetchGitRef).not.toHaveBeenCalled();
    expect(dependencies.ensureWorkspaceWorktree).not.toHaveBeenCalled();
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
        agent_name: "codex-api",
        agent_type: "codex",
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

  it("stores a pending OpenCode session and launches the TUI", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      buildAgentStartCommand: vi.fn(() => makeOpencodeCommand()),
    });

    const workspace = await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        agent: "opencode",
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(
      makeWorkspaceRecord({
        agent_name: "opencode",
        agent_type: "opencode",
        agent_runtime: "native",
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
    );
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command:
        "OPENCODE_CONFIG_DIR=~/.config/opencode command -- 'opencode' " +
        "'--agent' 'build' '/tmp/worktrees/gh-42-fix-bug'",
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
    expect(dependencies.ensureWorkspaceWorktree).not.toHaveBeenCalled();
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
    expect(dependencies.ensureWorkspaceWorktree).not.toHaveBeenCalled();
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

  it("reuses an existing tmux window shell without recreating layout", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      tmuxWindowExists: vi.fn(async () => true),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%9",
            current_command: "zsh",
            current_path: "/tmp/other",
          }) satisfies TmuxPaneInfo,
      ),
    });

    await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.createTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.createTmuxLayout).not.toHaveBeenCalled();
    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(1, {
      pane_id: "%9",
      command: "cd -- '/tmp/worktrees/gh-42-fix-bug' && clear",
    });
    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(2, {
      pane_id: "%9",
      command:
        "CLAUDE_CONFIG_DIR=~/.claude command -- 'claude' '--model' 'opus' " +
        "'--session-id' 'claude-session' '--name' 'gh-42-fix-bug'",
    });
  });

  it("adopts an existing agent window without launching a second agent", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      tmuxWindowExists: vi.fn(async () => true),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%9",
            current_command: "claude",
            current_path: "/tmp/worktrees/gh-42-fix-bug",
          }) satisfies TmuxPaneInfo,
      ),
    });

    const workspace = await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
    expect(workspace.agent_sessions).toEqual([]);
  });

  it("errors when an existing agent pane is rooted at a different path", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      tmuxWindowExists: vi.fn(async () => true),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%9",
            current_command: "claude",
            current_path: "/tmp/other",
          }) satisfies TmuxPaneInfo,
      ),
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
    ).rejects.toThrow(
      "Existing tmux window kongctl:gh-42-fix-bug pane 0 is rooted at /tmp/other, expected /tmp/worktrees/gh-42-fix-bug",
    );
  });

  it("refuses to adopt an existing docker wrapper pane as a running agent", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      buildAgentStartCommand: vi.fn(() => makeCodexCommand()),
      tmuxWindowExists: vi.fn(async () => true),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%9",
            current_command: "agent-en-place",
            current_path: "/tmp/worktrees/gh-42-fix-bug",
          }) satisfies TmuxPaneInfo,
      ),
    });

    await expect(
      createWorkspace(
        {
          issue: 42,
          slug: "fix-bug",
          agent: "codex-api",
          runtime: "docker",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "Existing tmux window kongctl:gh-42-fix-bug has unsupported pane 0 command: agent-en-place",
    );
  });

  it("errors when an existing tmux window pane is occupied by another process", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      tmuxWindowExists: vi.fn(async () => true),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%9",
            current_command: "vim",
            current_path: "/tmp/worktrees/gh-42-fix-bug",
          }) satisfies TmuxPaneInfo,
      ),
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
    ).rejects.toThrow(
      "Existing tmux window kongctl:gh-42-fix-bug has unsupported pane 0 command: vim",
    );
    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
  });

  it("does not remove adopted git resources when later steps fail", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      ensureWorkspaceWorktree: vi.fn(async () => ({
        branch: "gh-42-fix-bug",
        worktree_path: "/tmp/worktrees/gh-42-fix-bug",
        adopted: true,
      })),
      tmuxWindowExists: vi.fn(async () => true),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%9",
            current_command: "zsh",
            current_path: "/tmp/worktrees/gh-42-fix-bug",
          }) satisfies TmuxPaneInfo,
      ),
      sendKeysToPane: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("agent launch failed")),
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
    expect(dependencies.removeWorktree).not.toHaveBeenCalled();
    expect(dependencies.killTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
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
