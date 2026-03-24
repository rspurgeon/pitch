import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOpencodeSessionForWorkspace } from "../opencode-session-store.js";

async function writeSessionFile(
  root: string,
  projectId: string,
  fileName: string,
  payload: unknown,
): Promise<void> {
  const directory = join(root, "opencode", "storage", "session", projectId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), JSON.stringify(payload), "utf-8");
}

describe("opencode session store", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("finds the earliest matching session for a workspace after the pending start", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pitch-opencode-session-"));
    tempRoots.push(tempRoot);

    await writeSessionFile(tempRoot, "project-a", "old.json", {
      id: "ses_old",
      directory: "/tmp/worktrees/other",
      time: {
        created: Date.parse("2026-03-24T10:19:00.000Z"),
      },
    });
    await writeSessionFile(tempRoot, "project-a", "match-first.json", {
      id: "ses_first",
      directory: "/tmp/worktrees/gh-42-fix-bug",
      time: {
        created: Date.parse("2026-03-24T10:20:05.000Z"),
      },
    });
    await writeSessionFile(tempRoot, "project-b", "match-later.json", {
      id: "ses_later",
      directory: "/tmp/worktrees/gh-42-fix-bug",
      time: {
        created: Date.parse("2026-03-24T10:21:10.000Z"),
      },
    });

    const session = await findOpencodeSessionForWorkspace({
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      started_at: "2026-03-24T10:20:00.000Z",
      agent_env: {
        XDG_DATA_HOME: tempRoot,
      },
      now: new Date("2026-03-24T10:30:00.000Z"),
    });

    expect(session).toEqual({
      id: "ses_first",
      directory: "/tmp/worktrees/gh-42-fix-bug",
      created_at: "2026-03-24T10:20:05.000Z",
      file_path: join(
        tempRoot,
        "opencode",
        "storage",
        "session",
        "project-a",
        "match-first.json",
      ),
    });
  });

  it("returns null when no matching session is present", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pitch-opencode-session-"));
    tempRoots.push(tempRoot);

    await writeSessionFile(tempRoot, "project-a", "other.json", {
      id: "ses_other",
      directory: "/tmp/worktrees/other",
      time: {
        created: Date.parse("2026-03-24T10:20:05.000Z"),
      },
    });

    const session = await findOpencodeSessionForWorkspace({
      worktree_path: "/tmp/worktrees/gh-42-fix-bug",
      started_at: "2026-03-24T10:20:00.000Z",
      agent_env: {
        XDG_DATA_HOME: tempRoot,
      },
      now: new Date("2026-03-24T10:30:00.000Z"),
    });

    expect(session).toBeNull();
  });
});
