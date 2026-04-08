import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as agentStatus from "../agent-status.js";
import { runCodexHookFromStdin } from "../codex-hook.js";

describe("runCodexHookFromStdin", () => {
  it("passes hook payloads through to the Codex hook handler", async () => {
    const handleCodexHookPayload = vi
      .spyOn(agentStatus, "handleCodexHookPayload")
      .mockResolvedValue({
        session_id: "session-1",
        agent_type: "codex",
        state: "running",
        cwd: "/tmp/demo",
        transcript_path: "/tmp/demo.jsonl",
        tty: "pts/21",
        tmux_session: "pitch",
        tmux_window: "tmux-sidebar",
        tmux_pane_id: "%21",
        tmux_pane_index: 0,
        last_event: "UserPromptSubmit",
        last_assistant_message: undefined,
        updated_at: "2026-04-08T12:00:00.000Z",
      });

    const stderrBuffer: string[] = [];
    const exitCode = await runCodexHookFromStdin(
      Readable.from([
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "session-1",
          cwd: "/tmp/demo",
        }),
      ]),
      {
        write(chunk: string) {
          stderrBuffer.push(chunk);
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(handleCodexHookPayload).toHaveBeenCalledWith({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: "/tmp/demo",
    });
    expect(stderrBuffer).toEqual([]);
  });

  it("reports invalid payloads to stderr", async () => {
    const stderrBuffer: string[] = [];
    const exitCode = await runCodexHookFromStdin(
      Readable.from(["not json"]),
      {
        write(chunk: string) {
          stderrBuffer.push(chunk);
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderrBuffer.join("")).toContain("pitch codex-hook failed");
  });
});
