import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { findCodexSessionForWorkspace } from "../codex-session-store.js";

async function writeRollout(
  root: string,
  dayPath: string,
  fileName: string,
  firstLine: string,
): Promise<void> {
  const directory = join(root, "sessions", dayPath);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), `${firstLine}\n`, "utf-8");
}

describe("codex session store", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("finds the earliest matching session for a workspace after the pending start", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pitch-codex-session-"));
    tempRoots.push(tempRoot);

    await writeRollout(
      tempRoot,
      "2026/03/23",
      "rollout-older.jsonl",
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "old-session",
          timestamp: "2026-03-23T14:20:00.000Z",
          cwd: "/tmp/worktrees/other",
        },
      }),
    );
    await writeRollout(
      tempRoot,
      "2026/03/23",
      "rollout-match-first.jsonl",
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-session-1",
          timestamp: "2026-03-23T14:27:05.000Z",
          cwd: "/tmp/worktrees/gh-42-fix-bug",
        },
      }),
    );
    await writeRollout(
      tempRoot,
      "2026/03/23",
      "rollout-match-later.jsonl",
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-session-2",
          timestamp: "2026-03-23T14:28:30.000Z",
          cwd: "/tmp/worktrees/gh-42-fix-bug",
        },
      }),
    );

    const session = await findCodexSessionForWorkspace({
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      started_at: "2026-03-23T14:27:00.000Z",
      agent_env: {
        CODEX_HOME: tempRoot,
      },
      now: new Date("2026-03-23T14:30:00.000Z"),
    });

    expect(session).toEqual({
      id: "codex-session-1",
      timestamp: "2026-03-23T14:27:05.000Z",
      cwd: "/tmp/worktrees/gh-42-fix-bug",
      file_path: join(
        tempRoot,
        "sessions",
        "2026/03/23",
        "rollout-match-first.jsonl",
      ),
    });
  });

  it("returns null when no matching session is present", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pitch-codex-session-"));
    tempRoots.push(tempRoot);

    await writeRollout(
      tempRoot,
      "2026/03/23",
      "rollout-other.jsonl",
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "other-session",
          timestamp: "2026-03-23T14:27:05.000Z",
          cwd: "/tmp/worktrees/other",
        },
      }),
    );

    const session = await findCodexSessionForWorkspace({
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      started_at: "2026-03-23T14:27:00.000Z",
      agent_env: {
        CODEX_HOME: tempRoot,
      },
      now: new Date("2026-03-23T14:30:00.000Z"),
    });

    expect(session).toBeNull();
  });

  it("finds a matching session created days after the pending start", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pitch-codex-session-"));
    tempRoots.push(tempRoot);

    await writeRollout(
      tempRoot,
      "2026/03/23",
      "rollout-delayed.jsonl",
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "delayed-session",
          timestamp: "2026-03-23T14:27:05.000Z",
          cwd: "/tmp/worktrees/gh-42-fix-bug",
        },
      }),
    );

    const session = await findCodexSessionForWorkspace({
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      started_at: "2026-03-20T14:27:00.000Z",
      agent_env: {
        CODEX_HOME: tempRoot,
      },
      now: new Date("2026-03-23T14:30:00.000Z"),
    });

    expect(session?.id).toBe("delayed-session");
  });
});
