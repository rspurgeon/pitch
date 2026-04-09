import { describe, expect, it, vi } from "vitest";
import type { AgentsView } from "../agents.js";
import { renderStatusRight } from "../status-right.js";

describe("renderStatusRight", () => {
  const getAgentsView = vi.fn(async (): Promise<AgentsView> => ({
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
    agents: [],
  }));

  it("returns an empty segment when there are no active agent sessions", async () => {
    await expect(
      renderStatusRight(
        {},
        {
          refreshAgentStatusSummary: vi.fn(async () => ({
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 0,
            counts: {
              running: 0,
              question: 0,
              idle: 0,
              error: 0,
            },
          })),
          getAgentsView,
        },
      ),
    ).resolves.toBe("");
  });

  it("renders compact counts in priority order", async () => {
    await expect(
      renderStatusRight(
        {},
        {
          refreshAgentStatusSummary: vi.fn(async () => ({
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 7,
            counts: {
              running: 3,
              question: 1,
              idle: 2,
              error: 1,
            },
          })),
          getAgentsView,
        },
      ),
    ).resolves.toBe("R:3 Q:1 I:2 E:1");
  });

  it("omits zero-value states and appends the configured separator", async () => {
    await expect(
      renderStatusRight(
        {
          separator: " | ",
        },
        {
          refreshAgentStatusSummary: vi.fn(async () => ({
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 2,
            counts: {
              running: 1,
              question: 0,
              idle: 1,
              error: 0,
            },
          })),
          getAgentsView,
        },
      ),
    ).resolves.toBe("R:1 I:1 | ");
  });

  it("renders running and idle agent badges when tmux format is enabled", async () => {
    const previousFormat = process.env.PITCH_STATUS_RIGHT_FORMAT;
    const originalDateNow = Date.now;

    process.env.PITCH_STATUS_RIGHT_FORMAT = "tmux";
    Date.now = () => 2_000;

    try {
      await expect(
        renderStatusRight(
          {},
          {
            refreshAgentStatusSummary: vi.fn(async () => ({
              generated_at: "2026-04-08T12:00:00.000Z",
              active_sessions: 4,
              counts: {
                running: 2,
                question: 1,
                idle: 1,
                error: 0,
              },
            })),
            getAgentsView: vi.fn(async (): Promise<AgentsView> => ({
              summary: {
                generated_at: "2026-04-08T12:00:00.000Z",
                active_sessions: 3,
                counts: {
                  running: 2,
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
                  state: "running",
                  session_id: "claude-session-1",
                  session_key: "claude-sessi",
                  last_event: "Notification",
                  updated_at: "2026-04-08T11:59:00.000Z",
                  tmux: {
                    session_name: "kongctl",
                    window_name: "kongctl",
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
                  updated_at: "2026-04-08T11:58:00.000Z",
                  tmux: {
                    session_name: "flog",
                    window_name: "flog",
                    pane_index: 2,
                    pane_id: "%3",
                    pane_tty: "pts/23",
                    current_command: "codex",
                    current_path: "/tmp/flog",
                  },
                },
              ],
            })),
          },
        ),
      ).resolves.toBe(
        "#[fg=#B7BDB5]🤖#[default] #[fg=#7DAF7D]●pitch:pr-42#[default] #[fg=#7DAF7D]|#[default] #[fg=#7DAF7D]●kongctl#[default] #[fg=#61AFEF]●flog#[default] #[fg=#E5C07B]?1#[default]",
      );
    } finally {
      Date.now = originalDateNow;
      if (previousFormat === undefined) {
        delete process.env.PITCH_STATUS_RIGHT_FORMAT;
      } else {
        process.env.PITCH_STATUS_RIGHT_FORMAT = previousFormat;
      }
    }
  });

  it("pulses the running symbol in tmux format", async () => {
    const previousFormat = process.env.PITCH_STATUS_RIGHT_FORMAT;
    const originalDateNow = Date.now;

    process.env.PITCH_STATUS_RIGHT_FORMAT = "tmux";
    Date.now = () => 3_000;

    try {
      await expect(
        renderStatusRight(
          {},
          {
            refreshAgentStatusSummary: vi.fn(async () => ({
              generated_at: "2026-04-08T12:00:00.000Z",
              active_sessions: 1,
              counts: {
                running: 2,
                question: 0,
                idle: 0,
                error: 0,
              },
            })),
            getAgentsView: vi.fn(async (): Promise<AgentsView> => ({
              summary: {
                generated_at: "2026-04-08T12:00:00.000Z",
                active_sessions: 1,
                counts: {
                  running: 2,
                  question: 0,
                  idle: 0,
                  error: 0,
                },
              },
              agents: [],
            })),
          },
        ),
      ).resolves.toBe("#[fg=#B7BDB5]🤖#[default] #[fg=#7DAF7D]·2#[default]");
    } finally {
      Date.now = originalDateNow;
      if (previousFormat === undefined) {
        delete process.env.PITCH_STATUS_RIGHT_FORMAT;
      } else {
        process.env.PITCH_STATUS_RIGHT_FORMAT = previousFormat;
      }
    }
  });

  it("falls back to counts when live agent identities are unavailable", async () => {
    const previousFormat = process.env.PITCH_STATUS_RIGHT_FORMAT;
    const originalDateNow = Date.now;

    process.env.PITCH_STATUS_RIGHT_FORMAT = "tmux";
    Date.now = () => 3_000;

    try {
      await expect(
        renderStatusRight(
          {},
          {
            refreshAgentStatusSummary: vi.fn(async () => ({
              generated_at: "2026-04-08T12:00:00.000Z",
              active_sessions: 2,
              counts: {
                running: 1,
                question: 0,
                idle: 1,
                error: 0,
              },
            })),
            getAgentsView: vi.fn(async (): Promise<AgentsView> => ({
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
              agents: [],
            })),
          },
        ),
      ).resolves.toBe(
        "#[fg=#B7BDB5]🤖#[default] #[fg=#7DAF7D]·1#[default] #[fg=#61AFEF]●1#[default]",
      );
    } finally {
      Date.now = originalDateNow;
      if (previousFormat === undefined) {
        delete process.env.PITCH_STATUS_RIGHT_FORMAT;
      } else {
        process.env.PITCH_STATUS_RIGHT_FORMAT = previousFormat;
      }
    }
  });
});
