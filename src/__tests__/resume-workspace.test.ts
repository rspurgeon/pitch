import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BuiltAgentCommand } from "../agent-launcher.js";
import type { EnsureCodexTrustedPathInput } from "../codex-trust.js";
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
    bootstrap_prompts: {
      issue: "Read issue #{issue_number} in {repo} on {branch} and wait.",
      pr: "Read global PR #{pr_number} in {repo} and wait.",
    },
    repos: {
      "kong/kongctl": {
        default_agent: "claude-enterprise",
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        additional_paths: [],
        bootstrap_prompts: {
          pr: "Read repo PR #{pr_number} in {repo} on {branch} and wait.",
        },
        agent_defaults: {
          runtime: undefined,
          args: [],
          env: {},
        },
        agent_overrides: {},
      },
    },
    environments: {},
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
  const workspace: WorkspaceRecord = {
    name: "gh-42-fix-bug",
    worktree_name: "gh-42-fix-bug",
    repo: "kong/kongctl",
    source_kind: "issue",
    source_number: 42,
    branch: "gh-42-fix-bug",
    worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    guest_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    base_branch: "main",
    tmux_session: "kongctl",
    tmux_window: "gh-42-fix-bug",
    agent_name: "claude-enterprise",
    agent_type: "claude",
    agent_runtime: "native",
    environment_name: null,
    environment_kind: "host",
    agent_pane_process: "claude",
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

  if (overrides.guest_worktree_path === undefined) {
    workspace.guest_worktree_path = workspace.worktree_path;
  }
  if (overrides.worktree_name === undefined) {
    workspace.worktree_name = workspace.name;
  }
  if (overrides.environment_name === undefined) {
    workspace.environment_name = null;
  }
  if (overrides.environment_kind === undefined) {
    workspace.environment_kind = "host";
  }
  if (overrides.agent_pane_process === undefined) {
    workspace.agent_pane_process =
      workspace.environment_kind === "vm-ssh"
        ? "ssh"
        : workspace.agent_runtime === "docker"
          ? "agent-en-place"
          : workspace.agent_type;
  }

  return workspace;
}

function makeClaudeResumeCommand(): BuiltAgentCommand {
  return {
    agent_name: "claude-enterprise",
    agent_type: "claude",
    runtime: "native",
    environment_name: undefined,
    environment_kind: "host",
    command: ["claude", "--resume", "claude-session-1"],
    env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    agent_env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    pane_process_name: "claude",
    session_id: "claude-session-1",
    warnings: [],
  };
}

function makeClaudeStartCommand(): BuiltAgentCommand {
  return {
    agent_name: "claude-enterprise",
    agent_type: "claude",
    runtime: "native",
    environment_name: undefined,
    environment_kind: "host",
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
    agent_env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    pane_process_name: "claude",
    session_id: "claude-session-2",
    warnings: [],
  };
}

function makeOpencodeResumeCommand(
  env: Record<string, string> = {
    OPENCODE_CONFIG_DIR: "~/.config/opencode",
  },
): BuiltAgentCommand {
  return {
    agent_name: "opencode",
    agent_type: "opencode",
    runtime: "native",
    environment_name: undefined,
    environment_kind: "host",
    command: ["opencode", "--session", "ses_123"],
    env,
    agent_env: env,
    pane_process_name: "opencode",
    session_id: "ses_123",
    warnings: [],
  };
}

function makeOpencodeStartCommand(
  env: Record<string, string> = {
    OPENCODE_CONFIG_DIR: "~/.config/opencode",
  },
): BuiltAgentCommand {
  return {
    agent_name: "opencode",
    agent_type: "opencode",
    runtime: "native",
    environment_name: undefined,
    environment_kind: "host",
    command: ["opencode", "--agent", "build", "/tmp/worktrees/gh-42-fix-bug"],
    env,
    agent_env: env,
    pane_process_name: "opencode",
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
    fastForwardWorktree: vi.fn(async () => undefined),
    fetchGitRef: vi.fn(async () => "refs/pitch/pr/42/head"),
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
    getTmuxPaneInfo: vi.fn(
      async () =>
        ({
          pane_id: "%1",
          current_command: "opencode",
          current_path: "/tmp/worktrees/gh-42-fix-bug",
        }) satisfies TmuxPaneInfo,
    ),
    isWorktreeDirty: vi.fn(async () => false),
    listWorktreesForBranch: vi.fn(async () => []),
    readPullRequest: vi.fn(async () => ({
      number: 42,
      title: "Example PR",
      state: "OPEN",
      base_ref_name: "main",
      head_ref_name: "feature/example",
      head_ref_oid: "abc123",
      is_cross_repository: false,
      url: "https://github.com/example/repo/pull/42",
    })),
    readWorkspaceRecord: vi.fn(async () => makeWorkspaceRecord()),
    restoreWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    })),
    runGitHubLifecycle: vi.fn(async () => []),
    sendKeysToPane: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    tmuxWindowExists: vi.fn(async () => true),
    writeWorkspaceRecord: vi.fn(async (workspace: WorkspaceRecord) => workspace),
    now: vi.fn(() => new Date("2026-03-23T04:00:00.000Z")),
    ensureOpencodeConfig: vi.fn(async () => undefined),
    ensureClaudeTrustedPaths: vi.fn(async () => undefined),
    ensureCodexTrustedPath: vi.fn(async (_input: EnsureCodexTrustedPathInput) => undefined),
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
      environment: undefined,
      workspace_name: "gh-42-fix-bug",
      opencode_config_path: undefined,
      session_id: "claude-session-1",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
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
    expect(dependencies.ensureClaudeTrustedPaths).toHaveBeenCalledWith({
      environment: { kind: "host" },
      workspace_paths: {
        host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
        agent_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
        guest_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      },
      repo: config.repos["kong/kongctl"],
      claude_config_dir: "~/.claude",
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

  it("restores a shared PR session using the underlying worktree name", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          name: "pr-690-e2e",
          worktree_name: "gh-353-env-yaml-tag",
          source_kind: "pr",
          source_number: 690,
          branch: "gh-353-env-yaml-tag",
          worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
          tmux_window: "pr-690-e2e",
        })),
      restoreWorktree: vi.fn(async () => ({
        branch: "gh-353-env-yaml-tag",
        worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
      })),
    });

    await resumeWorkspace(
      {
        name: "pr-690-e2e",
      },
      config,
      dependencies,
    );

    expect(dependencies.restoreWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-353-env-yaml-tag",
      branch: "gh-353-env-yaml-tag",
    });
  });

  it("syncs a PR workspace before resuming when requested", async () => {
    const config = makeConfig();
    const warnings: string[] = [];
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          name: "pr-42",
          source_kind: "pr",
          source_number: 42,
          branch: "feature/example",
          worktree_name: "pr-42",
          worktree_path: "/tmp/worktrees/pr-42",
          tmux_window: "pr-42",
        }),
      ),
      restoreWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-42",
      })),
      listWorktreesForBranch: vi.fn(async () => [
        {
          branch: "feature/example",
          worktree_path: "/tmp/worktrees/pr-42",
        },
        {
          branch: "feature/example",
          worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
        },
      ]),
    });

    await resumeWorkspace(
      {
        name: "pr-42",
        sync: true,
      },
      config,
      {
        ...dependencies,
        reportWarning: (warning) => warnings.push(warning),
      },
    );

    expect(dependencies.isWorktreeDirty).toHaveBeenCalledWith(
      "/tmp/worktrees/pr-42",
    );
    expect(dependencies.readPullRequest).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      pr_number: 42,
    });
    expect(dependencies.fetchGitRef).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      remote: "origin",
      fallback_remote: "https://github.com/kong/kongctl.git",
      source_ref: "refs/pull/42/head",
      destination_ref: "refs/pitch/pr/42/head",
    });
    expect(dependencies.fastForwardWorktree).toHaveBeenCalledWith({
      worktree_path: "/tmp/worktrees/pr-42",
      target_ref: "refs/pitch/pr/42/head",
    });
    expect(warnings).toEqual([
      "Syncing feature/example for pr-42 will also move the branch ref used by other worktrees: /tmp/worktrees/gh-353-env-yaml-tag.",
    ]);
  });

  it("fails sync when the worktree is dirty", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          name: "pr-42",
          source_kind: "pr",
          source_number: 42,
          branch: "feature/example",
          worktree_name: "pr-42",
          worktree_path: "/tmp/worktrees/pr-42",
          tmux_window: "pr-42",
        }),
      ),
      restoreWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-42",
      })),
      isWorktreeDirty: vi.fn(async () => true),
    });

    await expect(
      resumeWorkspace(
        {
          name: "pr-42",
          sync: true,
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "Cannot sync pr-42: worktree /tmp/worktrees/pr-42 contains modified or untracked files.",
    );
    expect(dependencies.fetchGitRef).not.toHaveBeenCalled();
    expect(dependencies.buildAgentResumeCommand).not.toHaveBeenCalled();
  });

  it("fails sync when a compatible agent pane is already running", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          name: "pr-42",
          source_kind: "pr",
          source_number: 42,
          branch: "feature/example",
          worktree_name: "pr-42",
          worktree_path: "/tmp/worktrees/pr-42",
          tmux_window: "pr-42",
          agent_sessions: [],
        }),
      ),
      restoreWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-42",
      })),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%1",
            current_command: "claude",
            current_path: "/tmp/worktrees/pr-42",
          }) satisfies TmuxPaneInfo,
      ),
    });

    await expect(
      resumeWorkspace(
        {
          name: "pr-42",
          sync: true,
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "Cannot sync pr-42 while a compatible agent pane is already running; use normal git commands inside the workspace instead.",
    );
    expect(dependencies.isWorktreeDirty).not.toHaveBeenCalled();
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
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      initial_prompt: undefined,
    });
    expect(workspace.agent_sessions.at(-1)).toEqual({
      id: "claude-session-2",
      started_at: "2026-03-23T04:00:00.000Z",
      status: "active",
    });
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 42,
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
    expect(dependencies.runGitHubLifecycle).not.toHaveBeenCalled();
  });

  it("treats the legacy vm agent marker as an active running agent", async () => {
    const worktreePath = await mkdtemp(
      join(process.cwd(), ".tmp-resume-workspace-legacy-vm-agent-"),
    );
    const legacyMarkerPath = join(worktreePath, ".pitch", "vm-agent-active");
    await mkdir(dirname(legacyMarkerPath), { recursive: true });
    await writeFile(legacyMarkerPath, "active");

    const config = makeConfig();
    config.environments["sandbox-vm"] = {
      kind: "vm-ssh",
      ssh_host: "sandbox.internal",
      ssh_user: "pitch",
      ssh_options: [],
      guest_workspace_root: "/srv/pitch/workspaces",
      shared_paths: [],
      bootstrap: {
        mise_install: true,
      },
    };

    const originalWorkspace = makeWorkspaceRecord({
      agent_name: "codex",
      agent_type: "codex",
      agent_sessions: [],
      environment_name: "sandbox-vm",
      environment_kind: "vm-ssh",
      worktree_path: worktreePath,
      guest_worktree_path: "/srv/pitch/workspaces/gh-42-fix-bug",
      agent_pane_process: "ssh",
    });
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => originalWorkspace),
      restoreWorktree: vi.fn(async () => ({
        branch: "gh-42-fix-bug",
        worktree_path: worktreePath,
      })),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%1",
            current_command: "ssh",
            current_path: worktreePath,
          }) satisfies TmuxPaneInfo,
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
    expect(dependencies.buildAgentStartCommand).not.toHaveBeenCalled();
    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
    expect(workspace).toEqual(originalWorkspace);

    await rm(worktreePath, {
      recursive: true,
      force: true,
    });
  });

  it("reuses an existing ssh pane for a vm-backed fresh launch", async () => {
    const config = makeConfig();
    config.environments["sandbox-vm"] = {
      kind: "vm-ssh",
      ssh_host: "sandbox.internal",
      ssh_user: "pitch",
      ssh_options: [],
      guest_workspace_root: "/srv/pitch/workspaces",
      shared_paths: [],
      bootstrap: {
        mise_install: true,
      },
    };

    const originalWorkspace = makeWorkspaceRecord({
      agent_name: "codex",
      agent_type: "codex",
      agent_sessions: [],
      environment_name: "sandbox-vm",
      environment_kind: "vm-ssh",
      guest_worktree_path: "/srv/pitch/workspaces/gh-42-fix-bug",
      agent_pane_process: "ssh",
    });
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => originalWorkspace),
      buildAgentStartCommand: vi.fn(() => ({
        agent_name: "codex",
        agent_type: "codex",
        runtime: "native",
        environment_name: "sandbox-vm",
        environment_kind: "vm-ssh",
        command: ["ssh", "-tt", "pitch@sandbox.internal"],
        env: {},
        agent_env: {
          CODEX_HOME: "~/.codex",
        },
        pane_process_name: "ssh",
        pane_reuse_command:
          "env CODEX_HOME=~/.codex codex --cd /srv/pitch/workspaces/gh-42-fix-bug",
        host_marker_path:
          "/tmp/worktrees/.pitch-state/gh-42-fix-bug/vm-agent-active",
        warnings: [],
      }) satisfies BuiltAgentCommand),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%1",
            current_command: "ssh",
            current_path: "/tmp/worktrees/gh-42-fix-bug",
          }) satisfies TmuxPaneInfo,
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
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalled();
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command:
        "env CODEX_HOME=~/.codex codex --cd /srv/pitch/workspaces/gh-42-fix-bug",
    });
    expect(workspace.agent_sessions.at(-1)).toEqual({
      id: "pending",
      started_at: "2026-03-23T04:00:00.000Z",
      status: "pending",
    });
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
        environment_name: undefined,
        environment_kind: "host",
        command: ["codex", "resume", "codex-session-1"],
        env: {
          CODEX_HOME: "~/.codex",
        },
        agent_env: {
          CODEX_HOME: "~/.codex",
        },
        pane_process_name: "codex",
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
      environment: undefined,
      workspace_name: "gh-42-fix-bug",
      opencode_config_path: undefined,
      session_id: "codex-session-1",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
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
        environment_name: undefined,
        environment_kind: "host",
        command: ["codex", "resume", "codex-session-new"],
        env: {
          CODEX_HOME: "~/.codex",
        },
        agent_env: {
          CODEX_HOME: "~/.codex",
        },
        pane_process_name: "codex",
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
      environment: undefined,
      workspace_name: "gh-42-fix-bug",
      opencode_config_path: undefined,
      session_id: "codex-session-new",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
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
        environment_name: undefined,
        environment_kind: "host",
        command: ["codex", "--cd", "/tmp/worktrees/gh-42-fix-bug"],
        env: {
          CODEX_HOME: "~/.codex",
        },
        agent_env: {
          CODEX_HOME: "~/.codex",
        },
        pane_process_name: "codex",
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
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      initial_prompt: undefined,
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
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 42,
    });
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
        environment_name: undefined,
        environment_kind: "host",
        command: ["agent-en-place", "codex"],
        env: {
          CODEX_HOME: "~/.codex-docker",
        },
        agent_env: {
          CODEX_HOME: "~/.codex-docker",
        },
        pane_process_name: "agent-en-place",
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
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      initial_prompt: undefined,
    });
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 42,
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

  it("runs configured pane commands when resume recreates the tmux layout", async () => {
    const config = makeConfig();
    config.repos["kong/kongctl"].pane_commands = {
      top_right: "nvim .",
      bottom_right: "make build",
    };
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

    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(1, {
      pane_id: "%1",
      command:
        "CLAUDE_CONFIG_DIR=~/.claude command -- 'claude' '--resume' " +
        "'claude-session-1'",
    });
    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(2, {
      pane_id: "%2",
      command: "nvim .",
    });
    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(3, {
      pane_id: "%3",
      command: "make build",
    });
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
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      initial_prompt: undefined,
    });
    expect(dependencies.findCodexSessionForWorkspace).not.toHaveBeenCalled();
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 42,
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
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      initial_prompt: undefined,
    });
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 42,
    });
  });

  it("does not run GitHub lifecycle automation on a true resume", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.runGitHubLifecycle).not.toHaveBeenCalled();
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

  it("reopens a closed workspace on resume", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          status: "closed",
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

    expect(dependencies.buildAgentResumeCommand).toHaveBeenCalledWith({
      config,
      agent: "claude-enterprise",
      repo: "kong/kongctl",
      environment: undefined,
      workspace_name: "gh-42-fix-bug",
      opencode_config_path: undefined,
      session_id: "claude-session-1",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(workspace).toEqual(
      makeWorkspaceRecord({
        status: "active",
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
      environment: undefined,
      workspace_name: "gh-42-fix-bug",
      opencode_config_path: undefined,
      session_id: "ses_123",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
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

  it("uses the generated OpenCode config for fresh relaunches", async () => {
    const config = makeConfig();
    config.repos["kong/kongctl"].additional_paths = ["~/go"];

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
      buildAgentStartCommand: vi.fn(() =>
        makeOpencodeStartCommand({
          OPENCODE_CONFIG_DIR: "~/.config/opencode",
          OPENCODE_CONFIG: "/tmp/.pitch/opencode/gh-42-fix-bug.json",
        }),
      ),
      ensureOpencodeConfig: vi.fn(
        async () => "/tmp/.pitch/opencode/gh-42-fix-bug.json",
      ),
    });

    await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.ensureOpencodeConfig).toHaveBeenCalledWith(
      {
        workspace_name: "gh-42-fix-bug",
        additional_paths: ["~/go"],
        base_config_path: undefined,
      },
      undefined,
    );
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: undefined,
        host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
        opencode_config_path: "/tmp/.pitch/opencode/gh-42-fix-bug.json",
      }),
    );
  });

  it("preserves an existing OPENCODE_CONFIG when rebuilding resume config", async () => {
    const config = makeConfig();
    config.repos["kong/kongctl"].additional_paths = ["~/go"];
    config.agents.opencode.env.OPENCODE_CONFIG = "~/.config/opencode/custom.json";

    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_name: "opencode",
          agent_type: "opencode",
          agent_env: {
            OPENCODE_CONFIG_DIR: "~/.config/opencode",
            OPENCODE_CONFIG: "~/.config/opencode/custom.json",
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
      buildAgentStartCommand: vi.fn(() =>
        makeOpencodeStartCommand({
          OPENCODE_CONFIG_DIR: "~/.config/opencode",
          OPENCODE_CONFIG: "/tmp/.pitch/opencode/gh-42-fix-bug.json",
        }),
      ),
      ensureOpencodeConfig: vi.fn(
        async () => "/tmp/.pitch/opencode/gh-42-fix-bug.json",
      ),
    });

    await resumeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.ensureOpencodeConfig).toHaveBeenCalledWith(
      {
        workspace_name: "gh-42-fix-bug",
        additional_paths: ["~/go"],
        base_config_path: "~/.config/opencode/custom.json",
      },
      undefined,
    );
  });

  it("does not send a deferred bootstrap prompt for a fresh attach-mode OpenCode launch", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          agent_name: "opencode",
          agent_type: "opencode",
          agent_env: {
            OPENCODE_SERVER_PASSWORD: "secret",
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
      buildAgentStartCommand: vi.fn(() => ({
        agent_name: "opencode",
        agent_type: "opencode",
        runtime: "native",
        environment_name: undefined,
        environment_kind: "host",
        command: [
          "opencode",
          "attach",
          "http://localhost:4096",
          "--dir",
          "/tmp/worktrees/gh-42-fix-bug",
        ],
        env: {
          OPENCODE_SERVER_PASSWORD: "secret",
        },
        agent_env: {
          OPENCODE_SERVER_PASSWORD: "secret",
        },
        pane_process_name: "opencode",
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

    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(1, {
      pane_id: "%1",
      command:
        "OPENCODE_SERVER_PASSWORD='secret' command -- 'opencode' " +
        "'attach' 'http://localhost:4096' '--dir' '/tmp/worktrees/gh-42-fix-bug'",
    });
    expect(dependencies.getTmuxPaneInfo).not.toHaveBeenCalled();
    expect(dependencies.sleep).not.toHaveBeenCalled();
    expect(dependencies.sendKeysToPane).toHaveBeenCalledTimes(1);
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
