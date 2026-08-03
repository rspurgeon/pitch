import { describe, expect, it, vi } from "vitest";
import type { AgentsView } from "../agents.js";
import type { AgentStatusSnapshot } from "../agent-status.js";
import { renderWaybarStatus, watchWaybarStatus } from "../waybar-status.js";

describe("renderWaybarStatus", () => {
  it("renders Waybar JSON with Pango-colored agent groups", async () => {
    const originalDateNow = Date.now;
    Date.now = () => 2_000;

    try {
      const rendered = await renderWaybarStatus({
        getAgentStatusSnapshot: vi.fn(async (): Promise<AgentStatusSnapshot> => ({
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
          sources: [],
          sessions: [],
        })),
        getAgentsView: vi.fn(async (): Promise<AgentsView> => ({
          summary: {
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 3,
            counts: {
              running: 1,
              question: 1,
              idle: 1,
              error: 0,
            },
          },
          agents: [
            {
              agent_type: "codex",
              state: "running",
              session_id: "codex-session-1",
              session_key: "codex-sessio",
              last_event: "UserPromptSubmit",
              updated_at: "2026-04-08T12:00:00.000Z",
              cwd: "/tmp/codex",
              tmux: {
                session_name: "pitch",
                window_name: "pr-42",
                pane_index: 0,
                pane_id: "%1",
                pane_tty: "pts/21",
                current_command: "codex",
                current_path: "/tmp/codex",
              },
            },
            {
              agent_type: "claude",
              state: "question",
              session_id: "claude-session-1",
              session_key: "claude-sessi",
              last_event: "Notification",
              updated_at: "2026-04-08T12:01:00.000Z",
              cwd: "/tmp/claude",
              tmux: {
                session_name: "pitch",
                window_name: "review fix",
                pane_index: 1,
                pane_id: "%2",
                pane_tty: "pts/22",
                current_command: "claude",
                current_path: "/tmp/claude",
              },
            },
            {
              agent_type: "codex",
              state: "idle",
              session_id: "codex-session-2",
              session_key: "codex-sessi2",
              last_event: "Stop",
              updated_at: "2026-04-08T11:59:00.000Z",
              cwd: "/tmp/idle",
              tmux: {
                session_name: "kongctl",
                window_name: "idle",
                pane_index: 2,
                pane_id: "%3",
                pane_tty: "pts/23",
                current_command: "codex",
                current_path: "/tmp/idle",
              },
            },
          ],
        })),
      });

      const payload = JSON.parse(rendered);
      expect(payload.class).toEqual(["pitch-agents", "question"]);
      expect(payload.text).toBe(
        '<span foreground="#B7BDB5">🤖</span> <span foreground="#7DAF7D">●</span> <span foreground="#E5C07B">? review-fix</span> <span foreground="#B7BDB5">‖</span> <span foreground="#7DAF7D">pr-42</span> <span foreground="#B7BDB5">‖</span> <span foreground="#61AFEF">idle</span>',
      );
      expect(payload.tooltip).toContain("Pitch Agents  R:1 Q:1 I:1 E:0");
      expect(payload.tooltip).toContain("question review-fix (claude) pitch:review fix");
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("falls back to raw agent snapshots when tmux agent view is unavailable", async () => {
    const rendered = await renderWaybarStatus({
      getAgentsView: vi.fn(async (): Promise<AgentsView> => {
        throw new Error("tmux unavailable");
      }),
      getAgentStatusSnapshot: vi.fn(async (): Promise<AgentStatusSnapshot> => ({
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
            session_id: "codex-session-1",
            agent_type: "codex",
            state: "running",
            cwd: "/tmp/fallback",
            transcript_path: "/tmp/codex.jsonl",
            tty: "pts/21",
            last_event: "UserPromptSubmit",
            last_assistant_message: undefined,
            error_message: undefined,
            updated_at: "2026-04-08T12:00:00.000Z",
          },
        ],
      })),
    });

    const payload = JSON.parse(rendered);
    expect(payload.class).toEqual(["pitch-agents", "running"]);
    expect(payload.text).toContain("fallback");
  });

  it("merges raw snapshot agents when the tmux view is partial", async () => {
    const rendered = await renderWaybarStatus({
      getAgentsView: vi.fn(async (): Promise<AgentsView> => ({
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
        agents: [
          {
            agent_type: "codex",
            state: "running",
            session_id: "home-session",
            session_key: "home-sessio",
            last_event: "UserPromptSubmit",
            updated_at: "2026-04-08T12:00:00.000Z",
            cwd: "/home/rspurgeon",
            tmux: {
              session_name: "avery",
              window_name: "avery",
              pane_index: 0,
              pane_id: "%1",
              pane_tty: "pts/21",
              current_command: "codex",
              current_path: "/home/rspurgeon",
            },
          },
        ],
      })),
      getAgentStatusSnapshot: vi.fn(async (): Promise<AgentStatusSnapshot> => ({
        summary: {
          generated_at: "2026-04-08T12:00:00.000Z",
          active_sessions: 2,
          counts: {
            running: 2,
            question: 0,
            idle: 0,
            error: 0,
          },
        },
        sources: [],
        sessions: [
          {
            session_id: "home-session",
            agent_type: "codex",
            state: "running",
            cwd: "/home/rspurgeon",
            transcript_path: "/tmp/home.jsonl",
            tty: "pts/21",
            last_event: "UserPromptSubmit",
            last_assistant_message: undefined,
            error_message: undefined,
            updated_at: "2026-04-08T12:00:00.000Z",
          },
          {
            session_id: "worktree-session",
            agent_type: "codex",
            state: "running",
            cwd: "/home/rspurgeon/.local/share/worktrees/kong/kongctl/pr-1561",
            transcript_path: "/tmp/worktree.jsonl",
            tty: "pts/22",
            last_event: "UserPromptSubmit",
            last_assistant_message: undefined,
            error_message: undefined,
            updated_at: "2026-04-08T12:01:00.000Z",
          },
        ],
      })),
    });

    const payload = JSON.parse(rendered);
    expect(payload.text).toContain("pr-1561");
    expect(payload.tooltip).toContain("running  pr-1561");
  });

  it("shows home sessions after worktree agents within the same state", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/home/rspurgeon";

    try {
      const rendered = await renderWaybarStatus({
        getAgentStatusSnapshot: vi.fn(async (): Promise<AgentStatusSnapshot> => ({
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
          sources: [],
          sessions: [],
        })),
        getAgentsView: vi.fn(async (): Promise<AgentsView> => ({
          summary: {
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 2,
            counts: {
              running: 2,
              question: 0,
              idle: 0,
              error: 0,
            },
          },
          agents: [
            {
              agent_type: "codex",
              state: "running",
              session_id: "home-session",
              session_key: "home-sessio",
              last_event: "UserPromptSubmit",
              updated_at: "2026-04-08T12:00:00.000Z",
              cwd: "/home/rspurgeon",
              tmux: {
                session_name: "avery",
                window_name: "avery",
                pane_index: 0,
                pane_id: "%1",
                pane_tty: "pts/21",
                current_command: "codex",
                current_path: "/home/rspurgeon",
              },
            },
            {
              agent_type: "codex",
              state: "running",
              session_id: "worktree-session",
              session_key: "worktree-s",
              last_event: "UserPromptSubmit",
              updated_at: "2026-04-08T12:00:00.000Z",
              cwd: "/home/rspurgeon/.local/share/worktrees/kong/kongctl/pr-1561",
              tmux: {
                session_name: "kongctl",
                window_name: "pr-1561-child-flags",
                pane_index: 1,
                pane_id: "%2",
                pane_tty: "pts/22",
                current_command: "codex",
                current_path: "/home/rspurgeon/.local/share/worktrees/kong/kongctl/pr-1561",
              },
            },
          ],
        })),
      });

      const text = JSON.parse(rendered).text as string;
      expect(text).toContain("pr-1561-child-flags");
      expect(text).toContain("avery");
      expect(text.indexOf("pr-1561-child-flags")).toBeLessThan(text.indexOf("avery"));
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("streams pulse frames without refreshing agent state every frame", async () => {
    const abortController = new AbortController();
    const writes: string[] = [];
    const getAgentsView = vi.fn(async (): Promise<AgentsView> => ({
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
      agents: [
        {
          agent_type: "codex",
          state: "running",
          session_id: "codex-session-1",
          session_key: "codex-sessio",
          last_event: "UserPromptSubmit",
          updated_at: "2026-04-08T12:00:00.000Z",
          cwd: "/tmp/codex",
          tmux: {
            session_name: "pitch",
            window_name: "pr-42",
            pane_index: 0,
            pane_id: "%1",
            pane_tty: "pts/21",
            current_command: "codex",
            current_path: "/tmp/codex",
          },
        },
      ],
    }));

    await watchWaybarStatus(
      {
        write(chunk: string) {
          writes.push(chunk);
          if (writes.length === 2) {
            abortController.abort();
          }
        },
      },
      {
        getAgentsView,
        getAgentStatusSnapshot: vi.fn(async (): Promise<AgentStatusSnapshot> => ({
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
          sources: [],
          sessions: [],
        })),
      },
      {
        pulseIntervalMs: 1,
        refreshIntervalMs: 10_000,
        signal: abortController.signal,
      },
    );

    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]!).text).toContain(
      '<span foreground="#7DAF7D">●</span> <span foreground="#7DAF7D">pr-42</span>',
    );
    expect(JSON.parse(writes[1]!).text).toContain(
      '<span foreground="#7DAF7D">·</span> <span foreground="#7DAF7D">pr-42</span>',
    );
    expect(getAgentsView).toHaveBeenCalledTimes(1);
  });
});
