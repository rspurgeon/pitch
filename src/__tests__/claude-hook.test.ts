import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as agentStatus from "../agent-status.js";
import { runClaudeHookFromStdin } from "../claude-hook.js";

describe("runClaudeHookFromStdin", () => {
  it("passes hook payloads through to the Claude hook handler", async () => {
    const handleClaudeHookPayload = vi
      .spyOn(agentStatus, "handleClaudeHookPayload")
      .mockResolvedValue({
        session_id: "session-1",
        agent_type: "claude",
        state: "question",
        cwd: "/tmp/demo",
        transcript_path: "/tmp/demo.jsonl",
        tty: "pts/21",
        tmux_session: "pitch",
        tmux_window: "tmux-sidebar",
        tmux_pane_id: "%21",
        tmux_pane_index: 0,
        last_event: "Notification",
        last_notification_message: "Claude is waiting for permission.",
        updated_at: "2026-04-08T12:00:00.000Z",
      });

    const stderrBuffer: string[] = [];
    const exitCode = await runClaudeHookFromStdin(
      Readable.from([
        JSON.stringify({
          hook_event_name: "Notification",
          session_id: "session-1",
          cwd: "/tmp/demo",
          message: "Claude is waiting for permission.",
        }),
      ]),
      {
        write(chunk: string) {
          stderrBuffer.push(chunk);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(handleClaudeHookPayload).toHaveBeenCalledWith({
      hook_event_name: "Notification",
      session_id: "session-1",
      cwd: "/tmp/demo",
      message: "Claude is waiting for permission.",
    });
    expect(stderrBuffer).toEqual([]);
  });

  it("reports invalid payloads to stderr", async () => {
    const stderrBuffer: string[] = [];
    const exitCode = await runClaudeHookFromStdin(
      Readable.from(["not json"]),
      {
        write(chunk: string) {
          stderrBuffer.push(chunk);
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderrBuffer.join("")).toContain("pitch claude-hook failed");
  });
});
