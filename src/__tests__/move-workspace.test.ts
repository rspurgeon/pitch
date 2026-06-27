import { describe, expect, it, vi } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  moveWorkspace,
  MoveWorkspaceError,
  type MoveWorkspaceDependencies,
} from "../move-workspace.js";
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
          args: [],
          env: {},
        },
        agent_overrides: {},
      },
    },
    environments: {},
    sandboxes: {},
    agents: {
      codex: {
        type: "codex",
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
  overrides: Partial<MoveWorkspaceDependencies> = {},
): MoveWorkspaceDependencies {
  return {
    ensureTmuxSession: vi.fn(async () => ({
      session_name: "kongctl-aigw",
      created: false,
    })),
    linkTmuxWindow: vi.fn(async () => undefined),
    readWorkspaceRecord: vi.fn(async () => makeWorkspaceRecord()),
    tmuxWindowExists: vi.fn(async (sessionName: string) =>
      sessionName === "kongctl"
    ),
    unlinkTmuxWindow: vi.fn(async () => undefined),
    writeWorkspaceRecord: vi.fn(
      async (workspace: WorkspaceRecord) => workspace,
    ),
    now: vi.fn(() => new Date("2026-03-23T04:00:00.000Z")),
    ...overrides,
  };
}

describe("move workspace", () => {
  it("links the live window, updates state, then unlinks the old session", async () => {
    const dependencies = makeDependencies();

    const workspace = await moveWorkspace(
      {
        name: "gh-42-fix-bug",
        tmux_session: "kongctl-aigw",
      },
      makeConfig(),
      dependencies,
    );

    expect(workspace.tmux_session).toBe("kongctl-aigw");
    expect(workspace.updated_at).toBe("2026-03-23T04:00:00.000Z");
    expect(dependencies.ensureTmuxSession).toHaveBeenCalledWith({
      session_name: "kongctl-aigw",
      start_directory: "/tmp/worktrees/gh-42-fix-bug",
    });
    expect(dependencies.tmuxWindowExists).toHaveBeenCalledWith(
      "kongctl",
      "gh-42-fix-bug",
    );
    expect(dependencies.tmuxWindowExists).toHaveBeenCalledWith(
      "kongctl-aigw",
      "gh-42-fix-bug",
    );
    expect(dependencies.linkTmuxWindow).toHaveBeenCalledWith({
      source_session_name: "kongctl",
      source_window_name: "gh-42-fix-bug",
      target_session_name: "kongctl-aigw",
    });
    expect(dependencies.writeWorkspaceRecord).toHaveBeenCalledWith(
      makeWorkspaceRecord({
        tmux_session: "kongctl-aigw",
        updated_at: "2026-03-23T04:00:00.000Z",
      }),
    );
    expect(dependencies.unlinkTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl",
      window_name: "gh-42-fix-bug",
    });
  });

  it("updates only state for closed workspaces", async () => {
    const dependencies = makeDependencies({
      readWorkspaceRecord: vi.fn(async () =>
        makeWorkspaceRecord({ status: "closed" }),
      ),
    });

    await expect(
      moveWorkspace(
        {
          name: "gh-42-fix-bug",
          tmux_session: "kongctl-aigw",
        },
        makeConfig(),
        dependencies,
      ),
    ).resolves.toMatchObject({
      tmux_session: "kongctl-aigw",
      status: "closed",
    });

    expect(dependencies.ensureTmuxSession).not.toHaveBeenCalled();
    expect(dependencies.linkTmuxWindow).not.toHaveBeenCalled();
    expect(dependencies.unlinkTmuxWindow).not.toHaveBeenCalled();
  });

  it("errors when the source tmux window is missing", async () => {
    const dependencies = makeDependencies({
      tmuxWindowExists: vi.fn(async () => false),
    });

    await expect(
      moveWorkspace(
        {
          name: "gh-42-fix-bug",
          tmux_session: "kongctl-aigw",
        },
        makeConfig(),
        dependencies,
      ),
    ).rejects.toThrow("Source tmux window not found");
  });

  it("errors when the target tmux window already exists", async () => {
    const dependencies = makeDependencies({
      tmuxWindowExists: vi.fn(async () => true),
    });

    await expect(
      moveWorkspace(
        {
          name: "gh-42-fix-bug",
          tmux_session: "kongctl-aigw",
        },
        makeConfig(),
        dependencies,
      ),
    ).rejects.toThrow("Target tmux window already exists");
  });

  it("rolls back the target link when state update fails", async () => {
    const dependencies = makeDependencies({
      writeWorkspaceRecord: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });

    await expect(
      moveWorkspace(
        {
          name: "gh-42-fix-bug",
          tmux_session: "kongctl-aigw",
        },
        makeConfig(),
        dependencies,
      ),
    ).rejects.toThrow("disk full");
    expect(dependencies.unlinkTmuxWindow).toHaveBeenCalledWith({
      session_name: "kongctl-aigw",
      window_name: "gh-42-fix-bug",
    });
  });

  it("warns when the old window link cannot be removed after state update", async () => {
    const warnings: string[] = [];
    const dependencies = makeDependencies({
      reportWarning: (warning) => warnings.push(warning),
      unlinkTmuxWindow: vi.fn(async ({ session_name }) => {
        if (session_name === "kongctl") {
          throw new Error("still attached");
        }
      }),
    });

    await expect(
      moveWorkspace(
        {
          name: "gh-42-fix-bug",
          tmux_session: "kongctl-aigw",
        },
        makeConfig(),
        dependencies,
      ),
    ).resolves.toMatchObject({
      tmux_session: "kongctl-aigw",
    });
    expect(warnings.join("\n")).toContain("failed to unlink old tmux window");
  });

  it("rejects invalid input", async () => {
    await expect(
      moveWorkspace(
        {
          name: "",
          tmux_session: "",
        },
        makeConfig(),
      ),
    ).rejects.toBeInstanceOf(MoveWorkspaceError);
  });
});
