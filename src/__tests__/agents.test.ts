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

  it("filters out stale tmux sessions whose pane is no longer running the agent", async () => {
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
          current_command: "codex",
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
});
