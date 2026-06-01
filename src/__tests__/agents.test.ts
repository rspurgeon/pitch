import { describe, expect, it, vi } from "vitest";
import type { AgentStatusSnapshot } from "../agent-status.js";
import { getAgentsView } from "../agents.js";
import type { WorkspaceRecord } from "../workspace-state.js";

describe("getAgentsView", () => {
  it("recovers tmux identity from the workspace for guest-backed sessions", async () => {
    const snapshot: AgentStatusSnapshot = {
      summary: {
        generated_at: "2026-04-08T12:00:00.000Z",
        active_sessions: 1,
        counts: {
          running: 1,
          question: 0,
          idle: 0,
          error: 0,
        },
      },
      sources: [],
      sessions: [
        {
          session_id: "claude-vm-1",
          agent_type: "claude",
          state: "running",
          cwd: "/srv/workspaces/gh-42-fix-bug",
          tty: "pts/44",
          last_event: "Notification",
          updated_at: "2026-04-08T12:00:00.000Z",
        },
      ],
    };
    const workspace: WorkspaceRecord = {
      name: "gh-42-fix-bug",
      worktree_name: "gh-42-fix-bug",
      repo: "rspurgeon/pitch",
      source_kind: "issue",
      source_number: 42,
      branch: "fix-bug",
      worktree_path: "/home/rspurgeon/.local/share/worktrees/gh-42-fix-bug",
      guest_worktree_path: "/srv/workspaces/gh-42-fix-bug",
      base_branch: "main",
      tmux_session: "pitch",
      tmux_window: "gh-42-fix-bug",
      agent_name: "claude-enterprise",
      agent_type: "claude",
      sandbox_name: undefined,
      environment_name: "sandbox-vm",
      environment_kind: "vm-ssh",
      agent_pane_process: "ssh",
      agent_env: {},
      agent_sessions: [],
      status: "active",
      created_at: "2026-04-08T12:00:00.000Z",
      updated_at: "2026-04-08T12:00:00.000Z",
    };

    const view = await getAgentsView({
      getAgentStatusSnapshot: vi.fn(async () => snapshot),
      listTmuxPanes: vi.fn(async () => []),
      listWorkspaceRecords: vi.fn(async () => [workspace]),
      focusTmuxPane: vi.fn(),
    });

    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]?.agent_name).toBe("claude-enterprise");
    expect(view.agents[0]?.tmux_session_name).toBe("pitch");
    expect(view.agents[0]?.tmux_window_name).toBe("gh-42-fix-bug");
    expect(view.agents[0]?.tmux).toBeUndefined();
  });

  it("drops unanchored sessions with no pane or workspace", async () => {
    const snapshot: AgentStatusSnapshot = {
      summary: {
        generated_at: "2026-04-08T12:00:00.000Z",
        active_sessions: 0,
        counts: {
          running: 0,
          question: 0,
          idle: 0,
          error: 0,
        },
      },
      sources: [
        {
          source: "host",
          summary: {
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 0,
            counts: {
              running: 0,
              question: 0,
              idle: 0,
              error: 0,
            },
          },
        },
      ],
      sessions: [
        {
          session_id: "unanchored-host-session",
          agent_type: "codex",
          state: "idle",
          cwd: "/home/rspurgeon",
          last_event: "Stop",
          updated_at: "2026-04-08T12:00:00.000Z",
        },
      ],
    };

    const view = await getAgentsView({
      getAgentStatusSnapshot: vi.fn(async () => snapshot),
      listTmuxPanes: vi.fn(async () => []),
      listWorkspaceRecords: vi.fn(async () => []),
      focusTmuxPane: vi.fn(),
    });

    expect(view.summary.active_sessions).toBe(0);
    expect(view.agents).toEqual([]);
  });

  it("does not force the workspace primary pane process onto secondary agents", async () => {
    const snapshot: AgentStatusSnapshot = {
      summary: {
        generated_at: "2026-04-08T12:00:00.000Z",
        active_sessions: 1,
        counts: {
          running: 0,
          question: 1,
          idle: 0,
          error: 0,
        },
      },
      sources: [
        {
          source: "host",
          summary: {
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 1,
            counts: {
              running: 0,
              question: 1,
              idle: 0,
              error: 0,
            },
          },
        },
      ],
      sessions: [
        {
          session_id: "claude-secondary",
          agent_type: "claude",
          state: "question",
          cwd: "/home/rspurgeon/.local/share/worktrees/gh-42-fix-bug",
          tty: "pts/31",
          tmux_session: "pitch",
          tmux_window: "gh-42-fix-bug",
          tmux_pane_id: "%34",
          tmux_pane_index: 2,
          last_event: "Notification",
          updated_at: "2026-04-08T12:00:00.000Z",
        },
      ],
    };
    const workspace: WorkspaceRecord = {
      name: "gh-42-fix-bug",
      worktree_name: "gh-42-fix-bug",
      repo: "rspurgeon/pitch",
      source_kind: "issue",
      source_number: 42,
      branch: "fix-bug",
      worktree_path: "/home/rspurgeon/.local/share/worktrees/gh-42-fix-bug",
      base_branch: "main",
      tmux_session: "pitch",
      tmux_window: "gh-42-fix-bug",
      agent_name: "codex-primary",
      agent_type: "codex",
      sandbox_name: undefined,
      environment_name: null,
      environment_kind: "host",
      agent_pane_process: "codex",
      agent_env: {},
      agent_sessions: [],
      status: "active",
      created_at: "2026-04-08T12:00:00.000Z",
      updated_at: "2026-04-08T12:00:00.000Z",
    };

    const view = await getAgentsView({
      getAgentStatusSnapshot: vi.fn(async () => snapshot),
      listTmuxPanes: vi.fn(async () => [
        {
          session_name: "pitch",
          window_name: "gh-42-fix-bug",
          pane_index: 2,
          pane_id: "%34",
          pane_tty: "/dev/pts/31",
          current_command: "claude",
          current_path: "/home/rspurgeon/.local/share/worktrees/gh-42-fix-bug",
        },
      ]),
      listWorkspaceRecords: vi.fn(async () => [workspace]),
      focusTmuxPane: vi.fn(),
    });

    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]?.session_id).toBe("claude-secondary");
    expect(view.agents[0]?.agent_name).toBeUndefined();
    expect(view.agents[0]?.tmux?.window_name).toBe("gh-42-fix-bug");
  });

  it("accepts Codex panes running under node while filtering stale tmux sessions", async () => {
    const snapshot: AgentStatusSnapshot = {
      summary: {
        generated_at: "2026-04-08T12:00:00.000Z",
        active_sessions: 2,
        counts: {
          running: 1,
          question: 0,
          idle: 1,
          error: 0,
        },
      },
      sources: [
        {
          source: "host",
          summary: {
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 2,
            counts: {
              running: 1,
              question: 0,
              idle: 1,
              error: 0,
            },
          },
        },
      ],
      sessions: [
        {
          session_id: "pitch-live",
          agent_type: "codex",
          state: "running",
          cwd: "/home/rspurgeon/dev/rspurgeon/pitch",
          tty: "pts/20",
          tmux_session: "pitch",
          tmux_window: "pitch",
          tmux_pane_id: "%19",
          tmux_pane_index: 1,
          last_event: "UserPromptSubmit",
          updated_at: "2026-04-08T12:00:00.000Z",
        },
        {
          session_id: "flog-stale",
          agent_type: "codex",
          state: "idle",
          cwd: "/home/rspurgeon/dev/rspurgeon/flog",
          tty: "pts/13",
          tmux_session: "flog",
          tmux_window: "flog",
          tmux_pane_id: "%12",
          tmux_pane_index: 1,
          last_event: "Stop",
          updated_at: "2026-04-08T11:59:00.000Z",
        },
      ],
    };

    const view = await getAgentsView({
      getAgentStatusSnapshot: vi.fn(async () => snapshot),
      listTmuxPanes: vi.fn(async () => [
        {
          session_name: "pitch",
          window_name: "pitch",
          pane_index: 1,
          pane_id: "%19",
          pane_tty: "/dev/pts/20",
          current_command: "node",
          current_path: "/home/rspurgeon/dev/rspurgeon/pitch",
        },
        {
          session_name: "flog",
          window_name: "flog",
          pane_index: 1,
          pane_id: "%12",
          pane_tty: "/dev/pts/13",
          current_command: "zsh",
          current_path: "/home/rspurgeon/dev/rspurgeon/flog",
        },
      ]),
      listWorkspaceRecords: vi.fn(async () => []),
      focusTmuxPane: vi.fn(),
    });

    expect(view.summary.active_sessions).toBe(2);
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]?.session_id).toBe("pitch-live");
  });

  it("accepts sandboxed Codex panes after the wrapper execs into the agent", async () => {
    const snapshot: AgentStatusSnapshot = {
      summary: {
        generated_at: "2026-04-08T12:00:00.000Z",
        active_sessions: 1,
        counts: {
          running: 1,
          question: 0,
          idle: 0,
          error: 0,
        },
      },
      sources: [
        {
          source: "host",
          summary: {
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 1,
            counts: {
              running: 1,
              question: 0,
              idle: 0,
              error: 0,
            },
          },
        },
      ],
      sessions: [
        {
          session_id: "gh-239-live",
          agent_type: "codex",
          state: "running",
          cwd: "/home/rspurgeon/.local/share/worktrees/kong/kongctl/gh-239-page",
          tty: "pts/22",
          tmux_session: "kongctl",
          tmux_window: "gh-239-page",
          tmux_pane_id: "%33",
          tmux_pane_index: 1,
          last_event: "UserPromptSubmit",
          updated_at: "2026-04-08T12:00:00.000Z",
        },
      ],
    };
    const workspace: WorkspaceRecord = {
      name: "gh-239-page",
      worktree_name: "gh-239-page",
      repo: "kong/kongctl",
      source_kind: "issue",
      source_number: 239,
      branch: "gh-239-page",
      worktree_path: "/home/rspurgeon/.local/share/worktrees/kong/kongctl/gh-239-page",
      base_branch: "main",
      tmux_session: "kongctl",
      tmux_window: "gh-239-page",
      agent_name: "codex",
      agent_type: "codex",
      sandbox_name: "kongctl",
      environment_name: "host",
      environment_kind: "host",
      agent_pane_process: "nono",
      agent_env: {},
      agent_sessions: [],
      status: "active",
      created_at: "2026-04-08T12:00:00.000Z",
      updated_at: "2026-04-08T12:00:00.000Z",
    };

    const view = await getAgentsView({
      getAgentStatusSnapshot: vi.fn(async () => snapshot),
      listTmuxPanes: vi.fn(async () => [
        {
          session_name: "kongctl",
          window_name: "gh-239-page",
          pane_index: 1,
          pane_id: "%33",
          pane_tty: "/dev/pts/22",
          current_command: "codex",
          current_path: "/home/rspurgeon/.local/share/worktrees/kong/kongctl/gh-239-page",
        },
      ]),
      listWorkspaceRecords: vi.fn(async () => [workspace]),
      focusTmuxPane: vi.fn(),
    });

    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]?.session_id).toBe("gh-239-live");
    expect(view.agents[0]?.tmux?.window_name).toBe("gh-239-page");
  });
});
