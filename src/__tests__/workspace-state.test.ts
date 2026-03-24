import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteWorkspaceRecord,
  ensureWorkspacesDir,
  listWorkspaceRecords,
  readWorkspaceRecord,
  type WorkspaceRecord,
  WorkspaceStateError,
  updateWorkspaceRecord,
  writeWorkspaceRecord,
} from "../workspace-state.js";

function makeWorkspace(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    name: "gh-565-fix-validation",
    repo: "kong/kongctl",
    issue: 565,
    branch: "gh-565-fix-validation",
    worktree_path: "~/.local/share/worktrees/kong/kongctl/gh-565-fix-validation",
    base_branch: "main",
    tmux_session: "kongctl",
    tmux_window: "gh-565-fix-validation",
    agent_name: "codex",
    agent_type: "codex",
    agent_runtime: "native",
    agent_env: { CODEX_HOME: "~/.codex" },
    agent_sessions: [
      {
        id: "019d11a3-0c62-76b0-a4c0-59056df51009",
        started_at: "2026-03-20T10:30:00Z",
        status: "active",
      },
    ],
    status: "active",
    created_at: "2026-03-20T10:30:00Z",
    updated_at: "2026-03-20T10:30:00Z",
    ...overrides,
  };
}

describe("workspace state", () => {
  let tempRoot: string;
  let workspacesDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pitch-workspaces-"));
    workspacesDir = join(tempRoot, "workspaces");
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("creates the workspace state directory when missing", async () => {
    await ensureWorkspacesDir(workspacesDir);
    await expect(access(workspacesDir)).resolves.toBeUndefined();
  });

  it("writes and reads a workspace record", async () => {
    const workspace = makeWorkspace();

    await writeWorkspaceRecord(workspace, workspacesDir);

    const filePath = join(workspacesDir, `${workspace.name}.yaml`);
    const rawContent = await readFile(filePath, "utf-8");
    expect(rawContent).toContain(`name: ${workspace.name}`);

    await expect(readWorkspaceRecord(workspace.name, workspacesDir)).resolves.toEqual(
      workspace,
    );
  });

  it("returns null when reading a missing workspace record", async () => {
    await expect(
      readWorkspaceRecord("gh-999-missing", workspacesDir),
    ).resolves.toBeNull();
  });

  it("rejects workspace records with unexpected fields", async () => {
    const workspace = makeWorkspace();
    await writeWorkspaceRecord(workspace, workspacesDir);

    const filePath = join(workspacesDir, `${workspace.name}.yaml`);
    const rawContent = await readFile(filePath, "utf-8");
    await writeFile(filePath, `${rawContent}unexpected_field: true\n`, "utf-8");

    await expect(
      readWorkspaceRecord(workspace.name, workspacesDir),
    ).rejects.toThrow(WorkspaceStateError);
  });

  it("rejects a workspace file whose record name does not match the filename", async () => {
    const workspace = makeWorkspace();
    await writeWorkspaceRecord(workspace, workspacesDir);

    const filePath = join(workspacesDir, `${workspace.name}.yaml`);
    const rawContent = await readFile(filePath, "utf-8");
    await writeFile(
      filePath,
      rawContent.replace(
        `name: ${workspace.name}`,
        "name: gh-999-mismatched-record",
      ),
      "utf-8",
    );

    await expect(
      readWorkspaceRecord(workspace.name, workspacesDir),
    ).rejects.toThrow(WorkspaceStateError);
    await expect(listWorkspaceRecords({}, workspacesDir)).rejects.toThrow(
      WorkspaceStateError,
    );
  });

  it("lists all workspace records and supports filters", async () => {
    const active = makeWorkspace();
    const closed = makeWorkspace({
      name: "gh-566-close-workspace",
      issue: 566,
      branch: "gh-566-close-workspace",
      tmux_window: "gh-566-close-workspace",
      status: "closed",
      updated_at: "2026-03-21T10:30:00Z",
    });
    const otherRepo = makeWorkspace({
      name: "gh-567-other-repo",
      repo: "rspurgeon/pitch",
      issue: 567,
      branch: "gh-567-other-repo",
      worktree_path: "~/.local/share/worktrees/rspurgeon/pitch/gh-567-other-repo",
      tmux_session: "pitch",
      tmux_window: "gh-567-other-repo",
      updated_at: "2026-03-22T10:30:00Z",
    });

    await writeWorkspaceRecord(active, workspacesDir);
    await writeWorkspaceRecord(closed, workspacesDir);
    await writeWorkspaceRecord(otherRepo, workspacesDir);

    await expect(listWorkspaceRecords({}, workspacesDir)).resolves.toEqual([
      active,
      closed,
      otherRepo,
    ]);
    await expect(
      listWorkspaceRecords({ status: "active" }, workspacesDir),
    ).resolves.toEqual([active, otherRepo]);
    await expect(
      listWorkspaceRecords({ status: "closed" }, workspacesDir),
    ).resolves.toEqual([closed]);
    await expect(
      listWorkspaceRecords({ repo: "kong/kongctl" }, workspacesDir),
    ).resolves.toEqual([active, closed]);
    await expect(
      listWorkspaceRecords({ status: "all", repo: "rspurgeon/pitch" }, workspacesDir),
    ).resolves.toEqual([otherRepo]);
  });

  it("updates an existing workspace record", async () => {
    const workspace = makeWorkspace();
    await writeWorkspaceRecord(workspace, workspacesDir);

    const updated = await updateWorkspaceRecord(
      workspace.name,
      (current) => ({
        ...current,
        status: "closed",
        updated_at: "2026-03-21T10:30:00Z",
        agent_sessions: [
          ...current.agent_sessions,
          {
            id: "019d11a3-0c62-76b0-a4c0-59056df51010",
            started_at: "2026-03-21T10:30:00Z",
            status: "active",
          },
        ],
      }),
      workspacesDir,
    );

    expect(updated.status).toBe("closed");
    expect(updated.agent_sessions).toHaveLength(2);
    await expect(readWorkspaceRecord(workspace.name, workspacesDir)).resolves.toEqual(
      updated,
    );
  });

  it("rejects renaming a workspace during update", async () => {
    const workspace = makeWorkspace();
    await writeWorkspaceRecord(workspace, workspacesDir);

    await expect(
      updateWorkspaceRecord(
        workspace.name,
        (current) => ({
          ...current,
          name: "gh-999-renamed",
        }),
        workspacesDir,
      ),
    ).rejects.toThrow(WorkspaceStateError);
    await expect(readWorkspaceRecord(workspace.name, workspacesDir)).resolves.toEqual(
      workspace,
    );
  });

  it("deletes a workspace record", async () => {
    const workspace = makeWorkspace();
    await writeWorkspaceRecord(workspace, workspacesDir);

    await expect(
      deleteWorkspaceRecord(workspace.name, workspacesDir),
    ).resolves.toBe(true);
    await expect(
      readWorkspaceRecord(workspace.name, workspacesDir),
    ).resolves.toBeNull();
    await expect(
      deleteWorkspaceRecord(workspace.name, workspacesDir),
    ).resolves.toBe(false);
  });
});
