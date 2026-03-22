import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorktreePath,
  createWorktree,
  GitWorktreeError,
  removeWorktree,
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

  it("fails gracefully when removing a missing worktree", async () => {
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

  it("throws typed errors for invalid workspace names", async () => {
    await expect(
      createWorktree({
        repo,
        workspace_name: "../bad-name",
        base_branch: "main",
      }),
    ).rejects.toBeInstanceOf(GitWorktreeError);
  });
});
