import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorktreePath,
  createWorktree,
  ensureWorkspaceWorktree,
  GitWorktreeError,
  removeWorktree,
  restoreWorktree,
} from "../git.js";

const execFileAsync = promisify(execFile);

interface TestRepo {
  main_worktree: string;
  worktree_base: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createTempRepo(root: string): Promise<TestRepo> {
  const mainWorktree = join(root, "repo");
  const worktreeBase = join(root, "worktrees");

  await mkdir(mainWorktree, { recursive: true });
  await execFileAsync("git", ["init", "--initial-branch", "main"], {
    cwd: mainWorktree,
  });
  await git(["config", "user.name", "Pitch Test"], mainWorktree);
  await git(["config", "user.email", "pitch@example.com"], mainWorktree);
  await git(["config", "commit.gpgsign", "false"], mainWorktree);
  await writeFile(join(mainWorktree, "README.md"), "# Pitch Test\n", "utf-8");
  await git(["add", "README.md"], mainWorktree);
  await git(["commit", "-m", "Initial commit"], mainWorktree);

  return {
    main_worktree: mainWorktree,
    worktree_base: worktreeBase,
  };
}

describe("git worktree management", () => {
  let tempRoot: string;
  let repo: TestRepo;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pitch-git-"));
    repo = await createTempRepo(tempRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("constructs worktree paths from config", () => {
    expect(buildWorktreePath(repo, "gh-123-test-worktree")).toBe(
      join(repo.worktree_base, "gh-123-test-worktree"),
    );
  });

  it("creates a git worktree from the main worktree", async () => {
    const result = await createWorktree({
      repo,
      workspace_name: "gh-123-test-worktree",
      base_branch: "main",
    });

    expect(result).toEqual({
      branch: "gh-123-test-worktree",
      worktree_path: join(repo.worktree_base, "gh-123-test-worktree"),
    });
    await expect(
      git(["rev-parse", "--abbrev-ref", "HEAD"], result.worktree_path),
    ).resolves.toBe("gh-123-test-worktree");
    await expect(git(["branch", "--list", "gh-123-test-worktree"], repo.main_worktree))
      .resolves.toContain("gh-123-test-worktree");
  });

  it("removes an existing worktree", async () => {
    const created = await createWorktree({
      repo,
      workspace_name: "gh-124-remove-worktree",
      base_branch: "main",
    });

    const removed = await removeWorktree({
      repo,
      workspace_name: "gh-124-remove-worktree",
    });

    expect(removed).toEqual(created);
    await expect(
      git(["worktree", "list", "--porcelain"], repo.main_worktree),
    ).resolves.not.toContain(created.worktree_path);
  });

  it("fails gracefully when the main worktree does not exist", async () => {
    await expect(
      createWorktree({
        repo: {
          ...repo,
          main_worktree: join(tempRoot, "missing-repo"),
        },
        workspace_name: "gh-125-missing-main",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "MAIN_WORKTREE_MISSING",
    });
  });

  it("fails gracefully when the branch already exists", async () => {
    await git(["branch", "gh-126-existing-branch"], repo.main_worktree);

    await expect(
      createWorktree({
        repo,
        workspace_name: "gh-126-existing-branch",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "BRANCH_EXISTS",
    });
  });

  it("adopts an existing expected worktree path for the workspace", async () => {
    const created = await createWorktree({
      repo,
      workspace_name: "gh-126-adopt-worktree",
      base_branch: "main",
    });

    const ensured = await ensureWorkspaceWorktree({
      repo,
      workspace_name: "gh-126-adopt-worktree",
      base_branch: "main",
    });

    expect(ensured).toEqual({
      ...created,
      adopted: true,
    });
  });

  it("adopts an existing branch by restoring the expected worktree path", async () => {
    await git(["branch", "gh-126-adopt-branch"], repo.main_worktree);

    const ensured = await ensureWorkspaceWorktree({
      repo,
      workspace_name: "gh-126-adopt-branch",
      base_branch: "main",
    });

    expect(ensured).toEqual({
      branch: "gh-126-adopt-branch",
      worktree_path: join(repo.worktree_base, "gh-126-adopt-branch"),
      adopted: true,
    });
    await expect(
      git(["rev-parse", "--abbrev-ref", "HEAD"], ensured.worktree_path),
    ).resolves.toBe("gh-126-adopt-branch");
  });

  it("fails gracefully when the worktree path already exists", async () => {
    const worktreePath = join(repo.worktree_base, "gh-127-existing-worktree");
    await mkdir(worktreePath, { recursive: true });

    await expect(
      createWorktree({
        repo,
        workspace_name: "gh-127-existing-worktree",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "WORKTREE_EXISTS",
    });
  });

  it("rejects adopting an unrelated git repo at the expected worktree path", async () => {
    const worktreePath = join(repo.worktree_base, "gh-127-unrelated-repo");
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch", "gh-127-unrelated-repo"], {
      cwd: worktreePath,
    });

    await expect(
      ensureWorkspaceWorktree({
        repo,
        workspace_name: "gh-127-unrelated-repo",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "WORKTREE_EXISTS",
    });
  });

  it("fails gracefully when the worktree is already registered", async () => {
    const worktreePath = join(repo.worktree_base, "gh-127-registered-worktree");
    await mkdir(repo.worktree_base, { recursive: true });
    await git(["worktree", "add", "--detach", worktreePath, "main"], repo.main_worktree);
    await rm(worktreePath, { recursive: true, force: true });

    await expect(
      createWorktree({
        repo,
        workspace_name: "gh-127-registered-worktree",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "WORKTREE_EXISTS",
    });
  });

  it("fails gracefully when removing a missing worktree", async () => {
    await mkdir(join(repo.worktree_base, "gh-128-missing-worktree"), {
      recursive: true,
    });

    await expect(
      removeWorktree({
        repo,
        workspace_name: "gh-128-missing-worktree",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "WORKTREE_MISSING",
    });
  });

  it("surfaces git repository validation errors", async () => {
    const notRepo = join(tempRoot, "not-a-repo");
    await mkdir(notRepo, { recursive: true });

    await expect(
      createWorktree({
        repo: {
          ...repo,
          main_worktree: notRepo,
        },
        workspace_name: "gh-129-invalid-main-worktree",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "INVALID_MAIN_WORKTREE",
    });
  });

  it("rejects a git metadata directory as the main worktree", async () => {
    await expect(
      createWorktree({
        repo: {
          ...repo,
          main_worktree: join(repo.main_worktree, ".git"),
        },
        workspace_name: "gh-130-git-dir",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "INVALID_MAIN_WORKTREE",
    });
  });

  it("throws typed errors for invalid workspace names", async () => {
    await expect(
      createWorktree({
        repo,
        workspace_name: "../bad-name",
        base_branch: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "INVALID_WORKSPACE_NAME",
    });
  });

  it("restores a deleted worktree from its existing branch", async () => {
    const created = await createWorktree({
      repo,
      workspace_name: "gh-131-restore-worktree",
      base_branch: "main",
    });

    await rm(created.worktree_path, { recursive: true, force: true });

    const restored = await restoreWorktree({
      repo,
      workspace_name: "gh-131-restore-worktree",
    });

    expect(restored).toEqual(created);
    await expect(
      git(["rev-parse", "--abbrev-ref", "HEAD"], restored.worktree_path),
    ).resolves.toBe("gh-131-restore-worktree");
  });

  it("fails to restore when the branch no longer exists", async () => {
    await expect(
      restoreWorktree({
        repo,
        workspace_name: "gh-132-missing-branch",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "BRANCH_MISSING",
    });
  });
});
