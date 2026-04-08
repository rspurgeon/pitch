import { describe, expect, it, vi } from "vitest";
import { renderStatusRight } from "../status-right.js";

describe("renderStatusRight", () => {
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
        },
      ),
    ).resolves.toBe("R:1 I:1 | ");
  });

  it("renders colored symbols when tmux format is enabled", async () => {
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
          },
        ),
      ).resolves.toBe(
        "#[fg=#B7BDB5]🤖#[default] #[fg=#7DAF7D]●2#[default] #[fg=#61AFEF]●1#[default] #[fg=#E5C07B]?1#[default]",
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
});
