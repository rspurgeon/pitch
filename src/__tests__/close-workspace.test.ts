import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EnsureCodexTrustedPathInput } from "../codex-trust.js";
import type { PitchConfig } from "../config.js";
import { GitWorktreeError } from "../git.js";
import {
  closeWorkspace,
  deleteWorkspace,
  CloseWorkspaceError,
  DeleteWorkspaceError,
  type WorkspaceLifecycleDependencies,
} from "../close-workspace.js";
import { buildVmAgentHostMarkerPath } from "../execution-environment.js";
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
    bootstrap_prompts: {},
    repos: {
      "kong/kongctl": {
        default_agent: "codex",
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        additional_paths: [],
        bootstrap_prompts: {},
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
      codex: {
        type: "codex",
        runtime: "native",
        args: [],
        env: {},
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
    base_branch: "main",
    tmux_session: "kongctl",
    tmux_window: "gh-42-fix-bug",
    agent_name: "codex",
    agent_type: "codex",
    agent_runtime: "native",
    agent_env: {},
    agent_sessions: [
      {
        id: "pending",
        started_at: "2026-03-22T20:30:00.000Z",
        status: "pending",
      },
    ],
    status: "active",
    created_at: "2026-03-22T20:30:00.000Z",
    updated_at: "2026-03-22T20:30:00.000Z",
    ...overrides,
  };

  if (overrides.worktree_name === undefined) {
    workspace.worktree_name = workspace.name;
  }

  return workspace;
}

function makeDependencies(
  overrides: Partial<WorkspaceLifecycleDependencies> = {},
): WorkspaceLifecycleDependencies {
  return {
    deleteOpencodeConfig: vi.fn(async () => undefined),
    deleteWorkspaceRecord: vi.fn(async () => true),
    getTmuxWindowPaneInfo: vi.fn(
      async () =>
        ({
          pane_id: "%1",
          current_command: "codex",
          current_path: "/tmp/worktrees/gh-42-fix-bug",
        }) satisfies TmuxPaneInfo,
    ),
    isWorktreeDirty: vi.fn(async () => false),
    killTmuxWindow: vi.fn(async () => true),
    listWorkspaceRecords: vi.fn(async () => [makeWorkspaceRecord()]),
    readWorkspaceRecord: vi.fn(async () => makeWorkspaceRecord()),
    removeCodexTrustedPath: vi.fn(
      async (_input: EnsureCodexTrustedPathInput) => undefined,
    ),
    removeWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    })),
    sendKeysToPane: vi.fn(async () => undefined),
    writeWorkspaceRecord: vi.fn(
      async (workspace: WorkspaceRecord) => workspace,
    ),
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => new Date("2026-03-23T03:00:00.000Z")),
    ...overrides,
  };
}

describe("close workspace", () => {
  it("closes an active workspace without deleting state or worktree", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    const workspace = await closeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(
      makeWorkspaceRecord({
        status: "closed",
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command: "C-c",
      enter: false,
    });
    expect(dependencies.killTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
    });
    expect(dependencies.writeWorkspaceRecord).toHaveBeenCalledWith(
      makeWorkspaceRecord({
        status: "closed",
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
    expect(dependencies.removeWorktree).not.toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).not.toHaveBeenCalled();
    expect(dependencies.deleteOpencodeConfig).not.toHaveBeenCalled();
  });

  it("is idempotent for an already closed workspace", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          status: "closed",
        }),
      ),
    });

    await expect(
      closeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).resolves.toEqual(
      makeWorkspaceRecord({
        status: "closed",
      }),
    );
    expect(dependencies.killTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.writeWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("sends Ctrl-C to ssh-backed vm agent panes before closing", async () => {
    const worktreePath = await mkdtemp(
      join(process.cwd(), ".tmp-close-workspace-vm-agent-"),
    );
    const markerPath = buildVmAgentHostMarkerPath(
      worktreePath,
      "gh-42-fix-bug",
    );
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, "active");

    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          worktree_path: worktreePath,
          environment_name: "sandbox-vm",
          environment_kind: "vm-ssh",
          guest_worktree_path: "/srv/pitch/workspaces/gh-42-fix-bug",
          agent_pane_process: "ssh",
        }),
      ),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%1",
            current_command: "ssh",
            current_path: worktreePath,
          }) satisfies TmuxPaneInfo,
      ),
    });

    await closeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command: "C-c",
      enter: false,
    });

    await rm(worktreePath, {
      recursive: true,
      force: true,
    });
  });

  it("sends Ctrl-C to ssh-backed vm agent panes when only the legacy marker exists", async () => {
    const worktreePath = await mkdtemp(
      join(process.cwd(), ".tmp-close-workspace-legacy-vm-agent-"),
    );
    const legacyMarkerPath = join(worktreePath, ".pitch", "vm-agent-active");
    await mkdir(dirname(legacyMarkerPath), { recursive: true });
    await writeFile(legacyMarkerPath, "active");

    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          worktree_path: worktreePath,
          environment_name: "sandbox-vm",
          environment_kind: "vm-ssh",
          guest_worktree_path: "/srv/pitch/workspaces/gh-42-fix-bug",
          agent_pane_process: "ssh",
        }),
      ),
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%1",
            current_command: "ssh",
            current_path: worktreePath,
          }) satisfies TmuxPaneInfo,
      ),
    });

    await closeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command: "C-c",
      enter: false,
    });

    await rm(worktreePath, {
      recursive: true,
      force: true,
    });
  });

  it("fails when closing the tmux window fails", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      killTmuxWindow: vi.fn(async () => {
        throw new Error("tmux close failed");
      }),
    });

    await expect(
      closeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("Failed to close tmux window for gh-42-fix-bug");
    expect(dependencies.writeWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("rejects invalid input before reading state", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await expect(
      closeWorkspace(
        {
          name: "",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(CloseWorkspaceError);
    expect(dependencies.readWorkspaceRecord).not.toHaveBeenCalled();
  });
});

describe("delete workspace", () => {
  it("deletes a closed workspace and its worktree by default", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          status: "closed",
        }),
      ),
    });

    const workspace = await deleteWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(
      makeWorkspaceRecord({
        status: "closed",
      }),
    );
    expect(dependencies.isWorktreeDirty).toHaveBeenCalledWith(
      "/tmp/worktrees/gh-42-fix-bug",
    );
    expect(dependencies.removeWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      force: undefined,
    });
    expect(dependencies.removeCodexTrustedPath).toHaveBeenCalled();
    expect(dependencies.deleteOpencodeConfig).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
  });

  it("deletes an active workspace after first persisting it as closed", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await deleteWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.killTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
    });
    expect(dependencies.writeWorkspaceRecord).toHaveBeenCalledWith(
      makeWorkspaceRecord({
        status: "closed",
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
    expect(dependencies.removeWorktree).toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
  });

  it("removes only the session record when another workspace shares the worktree", async () => {
    const config = makeConfig();
    const primaryWorkspace = makeWorkspaceRecord({
      name: "pr-690-foo-bar",
      worktree_name: "gh-353-env-yaml-tag",
      source_kind: "pr",
      source_number: 690,
      branch: "gh-353-env-yaml-tag",
      worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
      tmux_window: "pr-690-foo-bar",
    });
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => primaryWorkspace),
      listWorkspaceRecords: vi.fn(async () => [
        primaryWorkspace,
        makeWorkspaceRecord({
          name: "pr-690-e2e",
          worktree_name: "gh-353-env-yaml-tag",
          source_kind: "pr",
          source_number: 690,
          branch: "gh-353-env-yaml-tag",
          worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
          tmux_window: "pr-690-e2e",
        }),
      ]),
    });

    const workspace = await deleteWorkspace(
      {
        name: "pr-690-foo-bar",
      },
      config,
      dependencies,
    );

    expect(workspace).toEqual(
      makeWorkspaceRecord({
        name: "pr-690-foo-bar",
        worktree_name: "gh-353-env-yaml-tag",
        source_kind: "pr",
        source_number: 690,
        branch: "gh-353-env-yaml-tag",
        worktree_path: "/tmp/worktrees/gh-353-env-yaml-tag",
        tmux_window: "pr-690-foo-bar",
        status: "closed",
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
    expect(dependencies.isWorktreeDirty).not.toHaveBeenCalled();
    expect(dependencies.removeWorktree).not.toHaveBeenCalled();
    expect(dependencies.removeCodexTrustedPath).not.toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith(
      "pr-690-foo-bar",
    );
  });

  it("refuses to delete a dirty worktree without force", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      isWorktreeDirty: vi.fn(async () => true),
    });

    await expect(
      deleteWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(
      "contains modified or untracked files; rerun with --force to delete it.",
    );
    expect(dependencies.killTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.writeWorkspaceRecord).not.toHaveBeenCalled();
    expect(dependencies.removeWorktree).not.toHaveBeenCalled();
  });

  it("allows force deletion of a dirty worktree", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      isWorktreeDirty: vi.fn(async () => true),
    });

    await deleteWorkspace(
      {
        name: "gh-42-fix-bug",
        force: true,
      },
      config,
      dependencies,
    );

    expect(dependencies.isWorktreeDirty).not.toHaveBeenCalled();
    expect(dependencies.removeWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      force: true,
    });
  });

  it("treats a missing worktree as already cleaned up", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({
          status: "closed",
        }),
      ),
      removeWorktree: vi.fn(async () => {
        throw new GitWorktreeError(
          "WORKTREE_MISSING",
          "Worktree does not exist at /tmp/worktrees/gh-42-fix-bug",
        );
      }),
    });

    await expect(
      deleteWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        config,
        dependencies,
      ),
    ).resolves.toEqual(
      makeWorkspaceRecord({
        status: "closed",
      }),
    );
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
  });

  it("rejects invalid input before reading state", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await expect(
      deleteWorkspace(
        {
          name: "",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow(DeleteWorkspaceError);
    expect(dependencies.readWorkspaceRecord).not.toHaveBeenCalled();
  });
});
