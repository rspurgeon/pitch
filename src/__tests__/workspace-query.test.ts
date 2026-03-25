import { describe, expect, it, vi } from "vitest";
import {
  getWorkspace,
  listWorkspaces,
  WorkspaceQueryError,
  type WorkspaceQueryDependencies,
} from "../workspace-query.js";
import type { WorkspaceRecord } from "../workspace-state.js";

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

function makeDependencies(
  overrides: Partial<WorkspaceQueryDependencies> = {},
): WorkspaceQueryDependencies {
  return {
    listWorkspaceRecords: vi.fn(async () => [makeWorkspaceRecord()]),
    readWorkspaceRecord: vi.fn(async () => makeWorkspaceRecord()),
    ...overrides,
  };
}

describe("workspace query tools", () => {
  it("lists workspace summaries and forwards filters", async () => {
    const dependencies = makeDependencies({
      listWorkspaceRecords: vi.fn(async () => [
        makeWorkspaceRecord(),
        makeWorkspaceRecord({
          name: "gh-43-follow-up",
          source_number: 43,
          agent_name: "codex",
          agent_type: "codex",
          status: "closed",
          tmux_window: "gh-43-follow-up",
        }),
      ]),
    });

    const workspaces = await listWorkspaces(
      {
        status: "all",
        repo: "kong/kongctl",
      },
      dependencies,
    );

    expect(workspaces).toEqual([
      {
        name: "gh-42-fix-bug",
        repo: "kong/kongctl",
        source_kind: "issue",
        source_number: 42,
        status: "active",
        agent_name: "claude-enterprise",
        agent_type: "claude",
        tmux_session: "kongctl",
        tmux_window: "gh-42-fix-bug",
      },
      {
        name: "gh-43-follow-up",
        repo: "kong/kongctl",
        source_kind: "issue",
        source_number: 43,
        status: "closed",
        agent_name: "codex",
        agent_type: "codex",
        tmux_session: "kongctl",
        tmux_window: "gh-43-follow-up",
      },
    ]);
    expect(dependencies.listWorkspaceRecords).toHaveBeenCalledWith({
      status: "all",
      repo: "kong/kongctl",
    });
  });

  it("rejects invalid list_workspaces input before reading state", async () => {
    const dependencies = makeDependencies();

    await expect(
      listWorkspaces(
        {
          repo: "",
        },
        dependencies,
      ),
    ).rejects.toThrow(WorkspaceQueryError);
    expect(dependencies.listWorkspaceRecords).not.toHaveBeenCalled();
  });

  it("wraps list_workspaces dependency failures in WorkspaceQueryError", async () => {
    const dependencies = makeDependencies({
      listWorkspaceRecords: vi.fn(async () => {
        throw new Error("filesystem exploded");
      }),
    });

    await expect(listWorkspaces({}, dependencies)).rejects.toThrow(
      "Failed to list workspaces: filesystem exploded",
    );
  });

  it("returns the full workspace record by name", async () => {
    const dependencies = makeDependencies();

    const workspace = await getWorkspace(
      {
        name: "gh-42-fix-bug",
      },
      dependencies,
    );

    expect(workspace).toEqual(makeWorkspaceRecord());
    expect(dependencies.readWorkspaceRecord).toHaveBeenCalledWith(
      "gh-42-fix-bug",
    );
  });

  it("returns a clear error when the workspace does not exist", async () => {
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => null),
    });

    await expect(
      getWorkspace(
        {
          name: "gh-404-missing",
        },
        dependencies,
      ),
    ).rejects.toThrow("Workspace not found: gh-404-missing");
  });

  it("rejects invalid get_workspace input before reading state", async () => {
    const dependencies = makeDependencies();

    await expect(
      getWorkspace(
        {
          name: "",
        },
        dependencies,
      ),
    ).rejects.toThrow(WorkspaceQueryError);
    expect(dependencies.readWorkspaceRecord).not.toHaveBeenCalled();
  });

  it("wraps workspace read failures in WorkspaceQueryError", async () => {
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () => {
        throw new Error("Invalid workspace name: ../oops");
      }),
    });

    await expect(
      getWorkspace(
        {
          name: "../oops",
        },
        dependencies,
      ),
    ).rejects.toThrow(
      'Failed to read workspace "../oops": Invalid workspace name: ../oops',
    );
  });
});
