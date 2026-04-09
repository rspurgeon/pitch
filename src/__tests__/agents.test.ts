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
});
