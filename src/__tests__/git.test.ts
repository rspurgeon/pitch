import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorktreePath,
  createWorktree,
  ensureWorkspaceWorktree,
  fastForwardWorktree,
  fetchGitRef,
  findManagedWorktreeForBranch,
  GitWorktreeError,
  listWorktreesForBranch,
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
      branch: "gh-123-test-worktree",
      start_point: "main",
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

  it("creates a worktree path from the workspace name while checking out a different branch", async () => {
    const result = await createWorktree({
      repo,
      workspace_name: "pr-543-debug-ci",
      branch: "feature/token-refresh",
      start_point: "main",
    });

    expect(result).toEqual({
      branch: "feature/token-refresh",
      worktree_path: join(repo.worktree_base, "pr-543-debug-ci"),
    });
    await expect(
      git(["rev-parse", "--abbrev-ref", "HEAD"], result.worktree_path),
    ).resolves.toBe("feature/token-refresh");
    await expect(
      git(["branch", "--list", "feature/token-refresh"], repo.main_worktree),
    ).resolves.toContain("feature/token-refresh");
  });

  it("removes an existing worktree", async () => {
    const created = await createWorktree({
      repo,
      workspace_name: "gh-124-remove-worktree",
      branch: "gh-124-remove-worktree",
      start_point: "main",
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

  it("rejects an explicit worktree path that does not match the managed workspace path", async () => {
    await createWorktree({
      repo,
      workspace_name: "gh-124-remove-worktree",
      branch: "gh-124-remove-worktree",
      start_point: "main",
    });
    const other = await createWorktree({
      repo,
      workspace_name: "gh-124-other-worktree",
      branch: "gh-124-other-worktree",
      start_point: "main",
    });

    await expect(
      removeWorktree({
        repo,
        workspace_name: "gh-124-remove-worktree",
        worktree_path: other.worktree_path,
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "INVALID_WORKTREE_PATH",
    });

    await expect(
      git(["worktree", "list", "--porcelain"], repo.main_worktree),
    ).resolves.toContain(other.worktree_path);
    await expect(
      git(["worktree", "list", "--porcelain"], repo.main_worktree),
    ).resolves.toContain(buildWorktreePath(repo, "gh-124-remove-worktree"));
  });

  it("force-removes a dirty worktree", async () => {
    const created = await createWorktree({
      repo,
      workspace_name: "gh-124-force-remove",
      branch: "gh-124-force-remove",
      start_point: "main",
    });

    await writeFile(join(created.worktree_path, "DIRTY.txt"), "dirty\n", "utf-8");

    const removed = await removeWorktree({
      repo,
      workspace_name: "gh-124-force-remove",
      force: true,
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
        branch: "gh-125-missing-main",
        start_point: "main",
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
        branch: "gh-126-existing-branch",
        start_point: "main",
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
      branch: "gh-126-adopt-worktree",
      start_point: "main",
    });

    const ensured = await ensureWorkspaceWorktree({
      repo,
      workspace_name: "gh-126-adopt-worktree",
      branch: "gh-126-adopt-worktree",
      start_point: "main",
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
      branch: "gh-126-adopt-branch",
      start_point: "main",
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

  it("restores an existing branch into a different workspace path", async () => {
    await git(["branch", "feature/token-refresh"], repo.main_worktree);

    const ensured = await ensureWorkspaceWorktree({
      repo,
      workspace_name: "pr-543-debug-ci",
      branch: "feature/token-refresh",
      start_point: "main",
    });

    expect(ensured).toEqual({
      branch: "feature/token-refresh",
      worktree_path: join(repo.worktree_base, "pr-543-debug-ci"),
      adopted: true,
    });
    await expect(
      git(["rev-parse", "--abbrev-ref", "HEAD"], ensured.worktree_path),
    ).resolves.toBe("feature/token-refresh");
  });

  it("can restore a second worktree for a branch that is already checked out", async () => {
    const existingPath = join(tempRoot, "outside-feature-token-refresh");
    await git(
      ["worktree", "add", "-b", "feature/token-refresh", existingPath, "main"],
      repo.main_worktree,
    );

    const ensured = await ensureWorkspaceWorktree({
      repo,
      workspace_name: "pr-543-debug-ci",
      branch: "feature/token-refresh",
      start_point: "main",
      allow_branch_reuse: true,
    });

    expect(ensured).toEqual({
      branch: "feature/token-refresh",
      worktree_path: join(repo.worktree_base, "pr-543-debug-ci"),
      adopted: true,
    });
    await expect(
      git(["rev-parse", "--abbrev-ref", "HEAD"], ensured.worktree_path),
    ).resolves.toBe("feature/token-refresh");
  });

  it("surfaces a typed error when the target branch is already checked out elsewhere", async () => {
    await git(["checkout", "-b", "feature/in-use"], repo.main_worktree);

    await expect(
      ensureWorkspaceWorktree({
        repo,
        workspace_name: "pr-543-debug-ci",
        branch: "feature/in-use",
        start_point: "main",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "BRANCH_IN_USE",
    });
  });

  it("finds a managed worktree for a checked-out branch", async () => {
    const created = await createWorktree({
      repo,
      workspace_name: "gh-353-env-yaml-tag",
      branch: "gh-353-env-yaml-tag",
      start_point: "main",
    });

    await git(
      ["branch", "-m", "gh-353-env-yaml-tag", "feature/example"],
      created.worktree_path,
    );

    await expect(
      findManagedWorktreeForBranch(repo, "feature/example"),
    ).resolves.toEqual({
      workspace_name: "gh-353-env-yaml-tag",
      branch: "feature/example",
      worktree_path: join(repo.worktree_base, "gh-353-env-yaml-tag"),
    });
  });

  it("lists all worktrees currently checking out a branch", async () => {
    await createWorktree({
      repo,
      workspace_name: "pr-543-debug-ci",
      branch: "feature/token-refresh",
      start_point: "main",
    });
    await ensureWorkspaceWorktree({
      repo,
      workspace_name: "pr-543-e2e",
      branch: "feature/token-refresh",
      start_point: "main",
      allow_branch_reuse: true,
    });

    await expect(
      listWorktreesForBranch(repo, "feature/token-refresh"),
    ).resolves.toEqual([
      {
        branch: "feature/token-refresh",
        worktree_path: join(repo.worktree_base, "pr-543-debug-ci"),
      },
      {
        branch: "feature/token-refresh",
        worktree_path: join(repo.worktree_base, "pr-543-e2e"),
      },
    ]);
  });

  it("ignores branch worktrees that live outside the managed worktree base", async () => {
    const outsidePath = join(tempRoot, "outside-feature-example");
    await git(
      ["worktree", "add", "-b", "feature/outside", outsidePath, "main"],
      repo.main_worktree,
    );

    await expect(
      findManagedWorktreeForBranch(repo, "feature/outside"),
    ).resolves.toBeNull();
  });

  it("normalizes configured and registered worktree paths before adoption", async () => {
    const actualBase = join(tempRoot, "actual-worktrees");
    const symlinkBase = join(tempRoot, "linked-worktrees");
    await mkdir(actualBase, { recursive: true });
    await symlink(actualBase, symlinkBase);

    const configuredRepo = {
      ...repo,
      worktree_base: symlinkBase,
    };

    await mkdir(symlinkBase, { recursive: true });
    const actualWorktreePath = join(actualBase, "gh-126-symlinked-worktree");
    await git(
      ["worktree", "add", "-b", "gh-126-symlinked-worktree", actualWorktreePath, "main"],
      repo.main_worktree,
    );

    const ensured = await ensureWorkspaceWorktree({
      repo: configuredRepo,
      workspace_name: "gh-126-symlinked-worktree",
      branch: "gh-126-symlinked-worktree",
      start_point: "main",
    });

    expect(ensured).toEqual({
      branch: "gh-126-symlinked-worktree",
      worktree_path: join(symlinkBase, "gh-126-symlinked-worktree"),
      adopted: true,
    });
  });

  it("fails gracefully when the worktree path already exists", async () => {
    const worktreePath = join(repo.worktree_base, "gh-127-existing-worktree");
    await mkdir(worktreePath, { recursive: true });

    await expect(
      createWorktree({
        repo,
        workspace_name: "gh-127-existing-worktree",
        branch: "gh-127-existing-worktree",
        start_point: "main",
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
        branch: "gh-127-unrelated-repo",
        start_point: "main",
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
        branch: "gh-127-registered-worktree",
        start_point: "main",
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
        branch: "gh-129-invalid-main-worktree",
        start_point: "main",
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
        branch: "gh-130-git-dir",
        start_point: "main",
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
        branch: "gh-130-bad-name",
        start_point: "main",
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
      branch: "gh-131-restore-worktree",
      start_point: "main",
    });

    await rm(created.worktree_path, { recursive: true, force: true });

    const restored = await restoreWorktree({
      repo,
      workspace_name: "gh-131-restore-worktree",
      branch: "gh-131-restore-worktree",
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
        branch: "gh-132-missing-branch",
      }),
    ).rejects.toMatchObject({
      name: "GitWorktreeError",
      code: "BRANCH_MISSING",
    });
  });

  it("falls back to an alternate remote when the primary fetch remote fails", async () => {
    const refName = await fetchGitRef({
      repo,
      remote: "missing-remote",
      fallback_remote: repo.main_worktree,
      source_ref: "refs/heads/main",
      destination_ref: "refs/pitch/test/main",
    });

    expect(refName).toBe("refs/pitch/test/main");
    await expect(
      git(["show-ref", "--verify", "refs/pitch/test/main"], repo.main_worktree),
    ).resolves.toContain("refs/pitch/test/main");
  });

  it("fast-forwards a worktree to a newer target ref", async () => {
    await git(["branch", "feature/sync", "main"], repo.main_worktree);

    const worktree = await ensureWorkspaceWorktree({
      repo,
      workspace_name: "pr-690",
      branch: "feature/sync",
      start_point: "main",
    });

    const targetPath = join(tempRoot, "feature-sync-target");
    await git(
      ["worktree", "add", "-b", "feature/sync-target", targetPath, "feature/sync"],
      repo.main_worktree,
    );
    await writeFile(join(targetPath, "SYNC.txt"), "updated\n", "utf-8");
    await git(["add", "SYNC.txt"], targetPath);
    await git(["commit", "-m", "sync target"], targetPath);

    await fastForwardWorktree({
      worktree_path: worktree.worktree_path,
      target_ref: "feature/sync-target",
    });

    await expect(
      git(["rev-parse", "--abbrev-ref", "HEAD"], worktree.worktree_path),
    ).resolves.toBe("feature/sync");
    await expect(
      git(["status", "--short"], worktree.worktree_path),
    ).resolves.toBe("");
    await expect(
      git(["rev-parse", "feature/sync"], repo.main_worktree),
    ).resolves.toBe(
      await git(["rev-parse", "feature/sync-target"], repo.main_worktree),
    );
  });
});
