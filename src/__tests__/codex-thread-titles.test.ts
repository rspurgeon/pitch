import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeCodexThreadTitles,
  syncCodexThreadTitles,
} from "../codex-thread-titles.js";
import type { AgentSession } from "../workspace-state.js";

describe("Codex thread title sync", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps the latest session at the workspace name and suffixes older sessions", () => {
    const sessions: AgentSession[] = [
      {
        id: "codex-session-oldest",
        started_at: "2026-03-21T04:00:00.000Z",
        status: "active",
      },
      {
        id: "codex-session-previous",
        started_at: "2026-03-22T04:00:00.000Z",
        status: "active",
      },
      {
        id: "codex-session-latest",
        started_at: "2026-03-23T04:00:00.000Z",
        status: "active",
      },
      {
        id: "codex-session-latest",
        started_at: "2026-03-23T05:00:00.000Z",
        status: "active",
      },
      {
        id: "pending",
        started_at: "2026-03-23T06:00:00.000Z",
        status: "pending",
      },
    ];

    expect(computeCodexThreadTitles("gh-42-fix-bug", sessions)).toEqual([
      {
        session_id: "codex-session-latest",
        title: "gh-42-fix-bug",
      },
      {
        session_id: "codex-session-previous",
        title: "gh-42-fix-bug - 1",
      },
      {
        session_id: "codex-session-oldest",
        title: "gh-42-fix-bug - 2",
      },
    ]);
  });

  it("appends legacy session index entries and updates SQLite titles", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pitch-codex-titles-"));
    tempRoots.push(tempRoot);
    const execFileAsync = vi.fn(async () => ({ stdout: "", stderr: "" }));

    const result = await syncCodexThreadTitles(
      {
        workspace_name: "gh-42-fix-bug",
        agent_env: {
          CODEX_HOME: tempRoot,
        },
        agent_sessions: [
          {
            id: "codex-session-old",
            started_at: "2026-03-22T04:00:00.000Z",
            status: "active",
          },
          {
            id: "codex-session-new",
            started_at: "2026-03-23T04:00:00.000Z",
            status: "active",
          },
        ],
        now: new Date("2026-03-23T04:00:00.000Z"),
      },
      {
        execFileAsync,
      },
    );

    expect(result.warnings).toEqual([]);
    expect(execFileAsync).toHaveBeenCalledWith("sqlite3", [
      join(tempRoot, "state_5.sqlite"),
      [
        "BEGIN IMMEDIATE;",
        "UPDATE threads SET title = CASE id WHEN 'codex-session-new' THEN 'gh-42-fix-bug' WHEN 'codex-session-old' THEN 'gh-42-fix-bug - 1' ELSE title END WHERE id IN ('codex-session-new', 'codex-session-old');",
        "COMMIT;",
      ].join("\n"),
    ]);

    const index = await readFile(join(tempRoot, "session_index.jsonl"), "utf8");
    expect(index.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      {
        id: "codex-session-new",
        thread_name: "gh-42-fix-bug",
        updated_at: "2026-03-23T04:00:00.000Z",
      },
      {
        id: "codex-session-old",
        thread_name: "gh-42-fix-bug - 1",
        updated_at: "2026-03-22T04:00:00.000Z",
      },
    ]);
  });
});
