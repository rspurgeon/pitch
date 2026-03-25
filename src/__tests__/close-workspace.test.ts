import { describe, expect, it, vi } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  closeWorkspace,
  CloseWorkspaceError,
  type CloseWorkspaceDependencies,
} from "../close-workspace.js";
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
}

function makeDependencies(
  overrides: Partial<CloseWorkspaceDependencies> = {},
): CloseWorkspaceDependencies {
  return {
    deleteWorkspaceRecord: vi.fn(async () => true),
    getTmuxWindowPaneInfo: vi.fn(
      async () =>
        ({
          pane_id: "%1",
          current_command: "codex",
          current_path: "/tmp/worktrees/gh-42-fix-bug",
        }) satisfies TmuxPaneInfo,
    ),
    killTmuxWindow: vi.fn(async () => true),
    readWorkspaceRecord: vi.fn(async () => makeWorkspaceRecord()),
    sendKeysToPane: vi.fn(async () => undefined),
    writeWorkspaceRecord: vi.fn(async (workspace: WorkspaceRecord) => workspace),
    removeWorktree: vi.fn(async () => ({
      branch: "gh-42-fix-bug",
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
    })),
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => new Date("2026-03-23T03:00:00.000Z")),
    ...overrides,
  };
}

describe("close workspace", () => {
  it("fully cleans up the workspace by default", async () => {
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
    expect(dependencies.killTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
    });
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command: "C-c",
      enter: false,
    });
    expect(dependencies.removeWorktree).toHaveBeenCalledWith({
      repo: config.repos["kong/kongctl"],
      workspace_name: "gh-42-fix-bug",
    });
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
    expect(dependencies.writeWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("persists a closed record when cleanup_worktree is false", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    const workspace = await closeWorkspace(
      {
        name: "gh-42-fix-bug",
        cleanup_worktree: false,
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
    expect(dependencies.killTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
    });
    expect(dependencies.sendKeysToPane).toHaveBeenCalledWith({
      pane_id: "%1",
      command: "C-c",
      enter: false,
    });
    expect(dependencies.writeWorkspaceRecord).toHaveBeenCalledWith(
      makeWorkspaceRecord({
        status: "closed",
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
    expect(dependencies.removeWorktree).not.toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("treats a missing tmux window as a successful close", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      killTmuxWindow: vi.fn(async () => false),
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
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
  });

  it("skips graceful shutdown when pane 0 is already a shell", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      getTmuxWindowPaneInfo: vi.fn(
        async () =>
          ({
            pane_id: "%1",
            current_command: "zsh",
            current_path: "/tmp/worktrees/gh-42-fix-bug",
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

    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
    expect(dependencies.killTmuxWindow).toHaveBeenCalled();
  });

  it("still closes the workspace when graceful shutdown inspection fails", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      getTmuxWindowPaneInfo: vi.fn(async () => {
        throw new Error("pane inspection failed");
      }),
    });

    await closeWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      config,
      dependencies,
    );

    expect(dependencies.sendKeysToPane).not.toHaveBeenCalled();
    expect(dependencies.killTmuxWindow).toHaveBeenCalled();
  });

  it("errors when closing the tmux window fails", async () => {
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
    expect(dependencies.removeWorktree).not.toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("errors when the workspace does not exist", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => null),
    });

    await expect(
      closeWorkspace(
        {
          name: "gh-404-missing",
        },
        config,
        dependencies,
      ),
    ).rejects.toThrow("Workspace not found: gh-404-missing");
    expect(dependencies.killTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.deleteWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("errors when the workspace is already closed", async () => {
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
    ).rejects.toThrow("Workspace already closed: gh-42-fix-bug");
    expect(dependencies.killTmuxWindow).not.toHaveBeenCalled();
  });

  it("fails cleanup when the workspace repo is no longer configured", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies();

    await expect(
      closeWorkspace(
        {
          name: "gh-42-fix-bug",
        },
        {
          ...config,
          repos: {},
        },
        dependencies,
      ),
    ).rejects.toThrow("Repo is not configured: kong/kongctl");
    expect(dependencies.killTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.removeWorktree).not.toHaveBeenCalled();
  });

  it("fails when worktree cleanup fails", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      removeWorktree: vi.fn(async () => {
        throw new Error("worktree remove failed");
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
    ).rejects.toThrow(
      "Failed to clean up worktree for gh-42-fix-bug: worktree remove failed",
    );
    expect(dependencies.deleteWorkspaceRecord).not.toHaveBeenCalled();
    expect(dependencies.writeWorkspaceRecord).toHaveBeenCalledWith(
      makeWorkspaceRecord({
        status: "closed",
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
  });

  it("reports fallback failure when worktree cleanup and closed-state write both fail", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      removeWorktree: vi.fn(async () => {
        throw new Error("worktree remove failed");
      }),
      writeWorkspaceRecord: vi.fn(async () => {
        throw new Error("fallback write failed");
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
    ).rejects.toThrow("Fallback state write also failed: fallback write failed");
  });

  it("falls back to a persisted closed record if deleting workspace state fails", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      deleteWorkspaceRecord: vi.fn(async () => {
        throw new Error("state delete failed");
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
    ).rejects.toThrow(
      "Failed to delete workspace state for gh-42-fix-bug: state delete failed",
    );
    expect(dependencies.writeWorkspaceRecord).toHaveBeenCalledWith(
      makeWorkspaceRecord({
        status: "closed",
        updated_at: "2026-03-23T03:00:00.000Z",
      }),
    );
  });

  it("reports fallback failure when deleting state and fallback write both fail", async () => {
    const config = makeConfig();
    const dependencies = makeDependencies({
      deleteWorkspaceRecord: vi.fn(async () => {
        throw new Error("state delete failed");
      }),
      writeWorkspaceRecord: vi.fn(async () => {
        throw new Error("fallback write failed");
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
    ).rejects.toThrow("Fallback state write also failed: fallback write failed");
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
