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
          issue: 43,
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
        issue: 42,
        status: "active",
        agent_type: "claude",
        tmux_session: "kongctl",
        tmux_window: "gh-42-fix-bug",
      },
      {
        name: "gh-43-follow-up",
        repo: "kong/kongctl",
        issue: 43,
        status: "closed",
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
});
