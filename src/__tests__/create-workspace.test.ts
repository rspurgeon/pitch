import { describe, expect, it, vi } from "vitest";
import type { BuiltAgentCommand } from "../agent-launcher.js";
import type { EnsureCodexTrustedPathInput } from "../codex-trust.js";
import type { PitchConfig } from "../config.js";
import { GitWorktreeError } from "../git.js";
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

function makeClaudeCommand(): BuiltAgentCommand {
  return {
    agent_name: "claude-enterprise",
    agent_type: "claude",
    runtime: "native",
    environment_name: undefined,
    environment_kind: "host",
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
    agent_env: {
      CLAUDE_CONFIG_DIR: "~/.claude",
    },
    pane_process_name: "claude",
    session_id: "claude-session",
    warnings: [],
  };
}

function makeCodexCommand(): BuiltAgentCommand {
  return {
    agent_name: "codex-api",
    agent_type: "codex",
    runtime: "docker",
    environment_name: undefined,
    environment_kind: "host",
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
    agent_env: {
      CODEX_HOME: "~/.codex-api",
      OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
    },
    pane_process_name: "agent-en-place",
    warnings: [],
  };
}

function makeOpencodeCommand(
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
    command: [
      "opencode",
      "--agent",
      "build",
      "/tmp/worktrees/gh-42-fix-bug",
    ],
    env,
    agent_env: env,
    pane_process_name: "opencode",
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
    findManagedWorktreeForBranch: vi.fn(async () => null),
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
    getTmuxPaneInfo: vi.fn(
      async () =>
        ({
          pane_id: "%1",
          current_command: "opencode",
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
    runGitHubLifecycle: vi.fn(async () => []),
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => new Date("2026-03-22T20:30:00.000Z")),
    ensureOpencodeConfig: vi.fn(async () => undefined),
    ensureClaudeTrustedPaths: vi.fn(async () => undefined),
    ensureCodexTrustedPath: vi.fn(async (_input: EnsureCodexTrustedPathInput) => undefined),
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
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      initial_prompt: "Read issue #42 in kong/kongctl on gh-42-fix-bug and wait.",
      override_args: ["--model", "opus"],
      runtime: undefined,
    });
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
      branch: "gh-42-fix-bug",
      start_point: "main",
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
        "CLAUDE_CONFIG_DIR=~/.claude command -- 'claude' '--model' 'opus' " +
        "'--session-id' 'claude-session' '--name' 'gh-42-fix-bug'",
    });
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 42,
    });

    const writeCallOrder = vi.mocked(
      dependencies.writeWorkspaceRecord,
    ).mock.invocationCallOrder[0];
    const sendCallOrder = vi.mocked(
      dependencies.sendKeysToPane,
    ).mock.invocationCallOrder[0];
    expect(writeCallOrder).toBeLessThan(sendCallOrder);
  });

  it("runs configured pane commands when creating a new tmux layout", async () => {
    const config = makeConfig();
    config.repos["kong/kongctl"].pane_commands = {
      top_right: "nvim .",
      bottom_right: "make build",
    };
    const dependencies = makeDependencies();

    await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(1, {
      pane_id: "%1",
      command:
        "CLAUDE_CONFIG_DIR=~/.claude command -- 'claude' '--model' 'opus' " +
        "'--session-id' 'claude-session' '--name' 'gh-42-fix-bug'",
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

  it("creates an issue workspace without a slug", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      ensureWorkspaceWorktree: vi.fn(async () => ({
        branch: "gh-42",
        worktree_path: "/tmp/worktrees/gh-42",
        adopted: false,
      })),
      buildAgentStartCommand: vi.fn(
        (): BuiltAgentCommand => ({
          ...makeClaudeCommand(),
          command: [
            "claude",
            "--model",
            "sonnet",
            "--session-id",
            "claude-session",
            "--name",
            "gh-42",
          ],
        }),
      ),
    });

    const workspace = await createWorkspace(
      {
        issue: 42,
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(
      makeWorkspaceRecord({
        name: "gh-42",
        worktree_name: "gh-42",
        branch: "gh-42",
        worktree_path: "/tmp/worktrees/gh-42",
        guest_worktree_path: "/tmp/worktrees/gh-42",
        tmux_window: "gh-42",
      }),
    );
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42",
      branch: "gh-42",
      start_point: "main",
    });
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "claude-enterprise",
      repo: "kong/kongctl",
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "gh-42",
      worktree_path: "/tmp/worktrees/gh-42",
      host_worktree_path: "/tmp/worktrees/gh-42",
      initial_prompt: "Read issue #42 in kong/kongctl on gh-42 and wait.",
      override_args: undefined,
      runtime: undefined,
    });
  });

  it("skips the bootstrap prompt when skip_prompt is true", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        skip_prompt: true,
      },
      config,
      dependencies,
    );

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
      override_args: undefined,
      runtime: undefined,
    });
  });

  it("creates a PR-backed workspace from the PR head branch", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      ensureWorkspaceWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-123",
        adopted: false,
      })),
      buildAgentStartCommand: vi.fn(
        (): BuiltAgentCommand => ({
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
            "claude-session",
            "--name",
            "pr-123-sync-pr",
          ],
          env: {
            CLAUDE_CONFIG_DIR: "~/.claude",
          },
          agent_env: {
            CLAUDE_CONFIG_DIR: "~/.claude",
          },
          pane_process_name: "claude",
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
      fallback_remote: "https://github.com/kong/kongctl.git",
      source_ref: "refs/pull/123/head",
      destination_ref: "refs/pitch/pr/123/head",
    });
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "pr-123",
      branch: "feature/example",
      start_point: "refs/pitch/pr/123/head",
      allow_branch_reuse: true,
    });
    expect(workspace).toEqual(
      makeWorkspaceRecord({
        name: "pr-123-sync-pr",
        worktree_name: "pr-123",
        source_kind: "pr",
        source_number: 123,
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-123",
        tmux_window: "pr-123-sync-pr",
      }),
    );
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "claude-enterprise",
      repo: "kong/kongctl",
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "pr-123-sync-pr",
      worktree_path: "/tmp/worktrees/pr-123",
      host_worktree_path: "/tmp/worktrees/pr-123",
      initial_prompt: "Read repo PR #123 in kong/kongctl on feature/example and wait.",
      override_args: undefined,
      runtime: undefined,
    });
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "pr",
      source_number: 123,
    });
  });

  it("creates a PR-backed workspace without a slug", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      ensureWorkspaceWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-123",
        adopted: false,
      })),
      buildAgentStartCommand: vi.fn(
        (): BuiltAgentCommand => ({
          ...makeClaudeCommand(),
          command: [
            "claude",
            "--model",
            "sonnet",
            "--session-id",
            "claude-session",
            "--name",
            "pr-123",
          ],
        }),
      ),
    });

    const workspace = await createWorkspace(
      {
        pr: 123,
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(
      makeWorkspaceRecord({
        name: "pr-123",
        worktree_name: "pr-123",
        source_kind: "pr",
        source_number: 123,
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/pr-123",
        guest_worktree_path: "/tmp/worktrees/pr-123",
        tmux_window: "pr-123",
      }),
    );
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "pr-123",
      branch: "feature/example",
      start_point: "refs/pitch/pr/123/head",
      allow_branch_reuse: true,
    });
    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith({
      config,
      agent: "claude-enterprise",
      repo: "kong/kongctl",
      environment: undefined,
      opencode_config_path: undefined,
      workspace_name: "pr-123",
      worktree_path: "/tmp/worktrees/pr-123",
      host_worktree_path: "/tmp/worktrees/pr-123",
      initial_prompt: "Read repo PR #123 in kong/kongctl on feature/example and wait.",
      override_args: undefined,
      runtime: undefined,
    });
  });

  it("reuses a tracked worktree when the PR head branch is already tracked", async () => {
    const config = makeConfig();
    const warnings: string[] = [];
    const dependencies = makeDependencies({
      listWorkspaceRecords: vi.fn(async () => [
        makeWorkspaceRecord({
          name: "gh-353-env-yaml-tag",
          branch: "feature/example",
          worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
          tmux_window: "gh-353-env-yaml-tag",
        }),
      ]),
      ensureWorkspaceWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
        adopted: true,
      })),
    });

    const workspace = await createWorkspace(
      {
        pr: 123,
        slug: "other-slug",
      },
      config,
      {
        ...dependencies,
        reportWarning: (warning) => warnings.push(warning),
      },
    );

    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-353-env-yaml-tag",
      branch: "feature/example",
      start_point: "refs/pitch/pr/123/head",
      allow_branch_reuse: true,
    });
    expect(workspace).toEqual(
      makeWorkspaceRecord({
        name: "pr-123-other-slug",
        worktree_name: "gh-353-env-yaml-tag",
        source_kind: "pr",
        source_number: 123,
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
        tmux_window: "pr-123-other-slug",
      }),
    );
    expect(warnings).toEqual([
      "PR head branch feature/example is already tracked by workspace gh-353-env-yaml-tag; reusing worktree gh-353-env-yaml-tag.",
    ]);
  });

  it("reuses an existing managed worktree on the PR head branch even without tracked state", async () => {
    const config = makeConfig();
    const warnings: string[] = [];
    const dependencies = makeDependencies({
      findManagedWorktreeForBranch: vi.fn(async () => ({
        workspace_name: "gh-353-env-yaml-tag",
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
      })),
      ensureWorkspaceWorktree: vi.fn(async () => ({
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
        adopted: true,
      })),
    });

    const workspace = await createWorkspace(
      {
        pr: 123,
      },
      config,
      {
        ...dependencies,
        reportWarning: (warning) => warnings.push(warning),
      },
    );

    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-353-env-yaml-tag",
      branch: "feature/example",
      start_point: "refs/pitch/pr/123/head",
      allow_branch_reuse: true,
    });
    expect(workspace).toEqual(
      makeWorkspaceRecord({
        name: "pr-123",
        worktree_name: "gh-353-env-yaml-tag",
        source_kind: "pr",
        source_number: 123,
        branch: "feature/example",
        worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
        guest_worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
        tmux_window: "pr-123",
      }),
    );
    expect(warnings).toEqual([
      "PR head branch feature/example is already checked out in managed worktree gh-353-env-yaml-tag; adopting that worktree.",
    ]);
  });

  it("surfaces a branch-in-use error when the PR head branch is already checked out elsewhere", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      ensureWorkspaceWorktree: vi.fn(async () => {
        throw new GitWorktreeError(
          "BRANCH_IN_USE",
          "Branch is already checked out in another worktree: feature/example",
        );
      }),
    });

    await expect(
      createWorkspace(
        {
          pr: 123,
          slug: "sync-pr",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "Failed to create workspace pr-123-sync-pr: Branch is already checked out in another worktree: feature/example",
    );
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledTimes(1);
    expect(dependencies.ensureWorkspaceWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "pr-123",
      branch: "feature/example",
      start_point: "refs/pitch/pr/123/head",
      allow_branch_reuse: true,
    });
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

  it("generates an OpenCode config when additional_paths are configured", async () => {
    const config = makeConfig();
    config.repos["kong/kongctl"].additional_paths = ["~/go"];

    const dependencies = makeDependencies({
      buildAgentStartCommand: vi.fn(() =>
        makeOpencodeCommand({
          OPENCODE_CONFIG_DIR: "~/.config/opencode",
          OPENCODE_CONFIG: "/tmp/.pitch/opencode/gh-42-fix-bug.json",
        }),
      ),
      ensureOpencodeConfig: vi.fn(
        async () => "/tmp/.pitch/opencode/gh-42-fix-bug.json",
      ),
    });

    await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        agent: "opencode",
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
        opencode_config_path: "/tmp/.pitch/opencode/gh-42-fix-bug.json",
      }),
    );
  });

  it("merges an existing OPENCODE_CONFIG into the generated config", async () => {
    const config = makeConfig();
    config.repos["kong/kongctl"].additional_paths = ["~/go"];
    config.agents.opencode.env.OPENCODE_CONFIG = "~/.config/opencode/custom.json";

    const dependencies = makeDependencies({
      buildAgentStartCommand: vi.fn(() =>
        makeOpencodeCommand({
          OPENCODE_CONFIG_DIR: "~/.config/opencode",
          OPENCODE_CONFIG: "/tmp/.pitch/opencode/gh-42-fix-bug.json",
        }),
      ),
      ensureOpencodeConfig: vi.fn(
        async () => "/tmp/.pitch/opencode/gh-42-fix-bug.json",
      ),
    });

    await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        agent: "opencode",
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

  it("sends a deferred bootstrap prompt for attach-mode OpenCode", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      buildAgentStartCommand: vi.fn(
        (): BuiltAgentCommand => ({
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
          post_launch_prompt:
            "Read issue #42 in kong/kongctl on gh-42-fix-bug and wait.",
          warnings: [],
        }),
      ),
    });

    await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        agent: "opencode",
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
    expect(dependencies.getTmuxPaneInfo).toHaveBeenCalledWith({
      pane_id: "%1",
    });
    expect(dependencies.sleep).toHaveBeenCalledWith(10000);
    expect(dependencies.sendKeysToPane).toHaveBeenNthCalledWith(2, {
      pane_id: "%1",
      command: "Read issue #42 in kong/kongctl on gh-42-fix-bug and wait.",
      literal: true,
    });
  });

  it("stores vm-backed workspace metadata and uses guest paths", async () => {
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

    const dependencies = makeDependencies({
      buildAgentStartCommand: vi.fn(
        (): BuiltAgentCommand => ({
          agent_name: "codex",
          agent_type: "codex",
          runtime: "native",
          environment_name: "sandbox-vm",
          environment_kind: "vm-ssh",
          command: [
            "ssh",
            "-tt",
            "pitch@sandbox.internal",
            "--",
            "remote-command",
          ],
          env: {},
          agent_env: {
            CODEX_HOME: "~/.codex",
          },
          pane_process_name: "ssh",
          warnings: [],
        }),
      ),
    });

    const workspace = await createWorkspace(
      {
        issue: 42,
        slug: "fix-bug",
        agent: "codex",
        environment: "sandbox-vm",
      },
      config,
      dependencies,
    );

    expect(dependencies.buildAgentStartCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: "sandbox-vm",
        host_worktree_path: "/tmp/worktrees/gh-42-fix-bug",
        worktree_path: "/srv/pitch/workspaces/gh-42-fix-bug",
      }),
    );
    expect(workspace).toEqual(
      makeWorkspaceRecord({
        agent_name: "codex",
        agent_type: "codex",
        environment_name: "sandbox-vm",
        environment_kind: "vm-ssh",
        guest_worktree_path: "/srv/pitch/workspaces/gh-42-fix-bug",
        agent_pane_process: "ssh",
        agent_env: {
          CODEX_HOME: "~/.codex",
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
        "command -- 'ssh' '-tt' 'pitch@sandbox.internal' '--' 'remote-command'",
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
    expect(dependencies.runGitHubLifecycle).toHaveBeenCalledWith({
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 42,
    });
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

  it("adopts an existing docker wrapper pane as a running agent", async () => {
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

    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
    expect(workspace.agent_sessions).toEqual([]);
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
