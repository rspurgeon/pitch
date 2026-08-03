import { describe, expect, it, vi } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  renameWorkspace,
  RenameWorkspaceError,
  type RenameWorkspaceDependencies,
} from "../rename-workspace.js";
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
    repos: {},
    environments: {},
    sandboxes: {},
    agents: {},
  };
}

function makeWorkspaceRecord(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    name: "scratch",
    worktree_name: "scratch",
    repo: "kong/kongctl",
    source_kind: "adhoc",
    source_number: null,
    branch: "feature/scratch",
    worktree_path: "/tmp/worktrees/scratch",
    base_branch: "main",
    tmux_session: "kongctl",
    tmux_window: "scratch",
    agent_name: "codex",
    agent_type: "codex",
    environment_name: null,
    environment_kind: "host",
    agent_env: {
      PITCH_WORKSPACE_NAME: "scratch",
    },
    agent_sessions: [],
    status: "active",
    created_at: "2026-07-21T12:00:00.000Z",
    updated_at: "2026-07-21T12:00:00.000Z",
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<RenameWorkspaceDependencies> = {},
): RenameWorkspaceDependencies {
  const workspace = makeWorkspaceRecord();
  return {
    deleteWorkspaceRecord: vi.fn(async () => true),
    readWorkspaceRecord: vi.fn(async (name: string) =>
      name === workspace.name ? workspace : null,
    ),
    renameTmuxWindow: vi.fn(async () => undefined),
    tmuxWindowExists: vi.fn(async (_sessionName: string, windowName: string) =>
      windowName === workspace.tmux_window,
    ),
    writeWorkspaceRecord: vi.fn(
      async (record: WorkspaceRecord) => record,
    ),
    now: vi.fn(() => new Date("2026-07-21T13:00:00.000Z")),
    ...overrides,
  };
}

describe("rename workspace", () => {
  it("renames an active ad hoc workspace and its tmux window", async () => {
    const dependencies = makeDependencies();

    const workspace = await renameWorkspace(
      {
        name: "scratch",
        new_name: "release-testing",
      },
      makeConfig(),
      dependencies,
    );

    expect(workspace).toMatchObject({
      name: "release-testing",
      worktree_name: "scratch",
      branch: "feature/scratch",
      worktree_path: "/tmp/worktrees/scratch",
      tmux_window: "release-testing",
      updated_at: "2026-07-21T13:00:00.000Z",
      agent_env: {
        PITCH_WORKSPACE_NAME: "release-testing",
      },
    });
    expect(dependencies.renameTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "scratch",
      new_window_name: "release-testing",
    });
    expect(dependencies.writeWorkspaceRecord).toHaveBeenCalledWith(workspace);
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith("scratch");
  });

  it("preserves the implicit worktree identity in legacy state", async () => {
    const workspace = makeWorkspaceRecord({ worktree_name: undefined });
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async (name: string) =>
        name === "scratch" ? workspace : null,
      ),
    });

    await expect(
      renameWorkspace(
        { name: "scratch", new_name: "renamed" },
        makeConfig(),
        dependencies,
      ),
    ).resolves.toMatchObject({
      name: "renamed",
      worktree_name: "scratch",
    });
  });

  it("renames closed workspace state without inspecting tmux", async () => {
    const workspace = makeWorkspaceRecord({ status: "closed" });
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async (name: string) =>
        name === "scratch" ? workspace : null,
      ),
    });

    await expect(
      renameWorkspace(
        { name: "scratch", new_name: "renamed" },
        makeConfig(),
        dependencies,
      ),
    ).resolves.toMatchObject({
      name: "renamed",
      status: "closed",
      tmux_window: "renamed",
    });
    expect(dependencies.tmuxWindowExists).not.toHaveBeenCalled();
    expect(dependencies.renameTmuxWindow).not.toHaveBeenCalled();
  });

  it("rejects an existing target workspace without changing tmux", async () => {
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async (name: string) =>
        name === "scratch"
          ? makeWorkspaceRecord()
          : makeWorkspaceRecord({ name: "renamed", tmux_window: "renamed" }),
      ),
    });

    await expect(
      renameWorkspace(
        { name: "scratch", new_name: "renamed" },
        makeConfig(),
        dependencies,
      ),
    ).rejects.toThrow("Target workspace already exists");
    expect(dependencies.renameTmuxWindow).not.toHaveBeenCalled();
  });

  it("rejects an existing target tmux window", async () => {
    const dependencies = makeDependencies({
      tmuxWindowExists: vi.fn(async () => true),
    });

    await expect(
      renameWorkspace(
        { name: "scratch", new_name: "renamed" },
        makeConfig(),
        dependencies,
      ),
    ).rejects.toThrow("Target tmux window already exists");
    expect(dependencies.renameTmuxWindow).not.toHaveBeenCalled();
  });

  it("rolls back the tmux window when writing new state fails", async () => {
    const dependencies = makeDependencies({
      writeWorkspaceRecord: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });

    await expect(
      renameWorkspace(
        { name: "scratch", new_name: "renamed" },
        makeConfig(),
        dependencies,
      ),
    ).rejects.toThrow("disk full");
    expect(dependencies.renameTmuxWindow).toHaveBeenNthCalledWith(2, {
      session_name: "kongctl",
      window_name: "renamed",
      new_window_name: "scratch",
    });
    expect(dependencies.deleteWorkspaceRecord).toHaveBeenCalledWith("renamed");
  });

  it("rejects active vm-ssh workspaces", async () => {
    const workspace = makeWorkspaceRecord({ environment_kind: "vm-ssh" });
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async (name: string) =>
        name === "scratch" ? workspace : null,
      ),
    });

    await expect(
      renameWorkspace(
        { name: "scratch", new_name: "renamed" },
        makeConfig(),
        dependencies,
      ),
    ).rejects.toThrow("close it first");
  });

  it("rejects invalid names", async () => {
    await expect(
      renameWorkspace(
        { name: "scratch", new_name: "bad/name" },
        makeConfig(),
      ),
    ).rejects.toBeInstanceOf(RenameWorkspaceError);
  });
});
