import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type GitRepoConfig = Pick<RepoConfig, "main_worktree" | "worktree_base">;

export interface CreateWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
  base_branch: string;
}

export interface RemoveWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
}

export interface WorktreeResult {
  branch: string;
  worktree_path: string;
}

type GitWorktreeErrorCode =
  | "MAIN_WORKTREE_MISSING"
  | "INVALID_MAIN_WORKTREE"
  | "INVALID_WORKSPACE_NAME"
  | "BRANCH_EXISTS"
  | "WORKTREE_EXISTS"
  | "WORKTREE_MISSING"
  | "COMMAND_FAILED";

export class GitWorktreeError extends Error {
  code: GitWorktreeErrorCode;

  constructor(code: GitWorktreeErrorCode, message: string) {
    super(message);
    this.name = "GitWorktreeError";
    this.code = code;
  }
}

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function formatGitError(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "stderr" in err &&
    typeof err.stderr === "string" &&
    err.stderr.length > 0
  ) {
    return err.stderr.trim();
  }

  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    return err.message;
  }

  return String(err);
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { cwd });
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Git command failed in ${cwd}: git ${args.join(" ")}\n${formatGitError(err)}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validateWorkspaceName(workspaceName: string): string {
  if (
    workspaceName.length === 0 ||
    workspaceName === "." ||
    workspaceName === ".." ||
    workspaceName.includes("/") ||
    workspaceName.includes("\\")
  ) {
    throw new GitWorktreeError(
      "INVALID_WORKSPACE_NAME",
      `Invalid workspace name: ${workspaceName}`,
    );
  }

  return workspaceName;
}

async function ensureMainWorktree(mainWorktree: string): Promise<void> {
  if (!(await pathExists(mainWorktree))) {
    throw new GitWorktreeError(
      "MAIN_WORKTREE_MISSING",
      `Main worktree does not exist: ${mainWorktree}`,
    );
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: mainWorktree },
    );

    if (stdout.trim() !== "true") {
      throw new GitWorktreeError(
        "INVALID_MAIN_WORKTREE",
        `Main worktree is not a git repository: ${mainWorktree}`,
      );
    }
  } catch (err: unknown) {
    if (err instanceof GitWorktreeError && err.code === "INVALID_MAIN_WORKTREE") {
      throw err;
    }

    throw new GitWorktreeError(
      "INVALID_MAIN_WORKTREE",
      `Main worktree is not a git repository: ${mainWorktree}`,
    );
  }
}

async function listRegisteredWorktrees(mainWorktree: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: mainWorktree },
    );

    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to list registered worktrees in ${mainWorktree}\n${formatGitError(err)}`,
    );
  }
}

async function branchExists(
  mainWorktree: string,
  branch: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: mainWorktree },
    );
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === 1
    ) {
      return false;
    }

    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to check whether branch exists: ${branch}\n${formatGitError(err)}`,
    );
  }
}

export function buildWorktreePath(
  repo: Pick<GitRepoConfig, "worktree_base">,
  workspaceName: string,
): string {
  return join(expandHomePath(repo.worktree_base), validateWorkspaceName(workspaceName));
}

export async function createWorktree(
  params: CreateWorktreeParams,
): Promise<WorktreeResult> {
  const branch = validateWorkspaceName(params.workspace_name);
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  const worktreePath = buildWorktreePath(params.repo, branch);

  await ensureMainWorktree(mainWorktree);

  if (await branchExists(mainWorktree, branch)) {
    throw new GitWorktreeError(
      "BRANCH_EXISTS",
      `Branch already exists: ${branch}`,
    );
  }

  const registeredWorktrees = await listRegisteredWorktrees(mainWorktree);
  if (
    registeredWorktrees.includes(worktreePath) ||
    (await pathExists(worktreePath))
  ) {
    throw new GitWorktreeError(
      "WORKTREE_EXISTS",
      `Worktree already exists at ${worktreePath}`,
    );
  }

  await mkdir(expandHomePath(params.repo.worktree_base), { recursive: true });
  await runGit(
    ["worktree", "add", "-b", branch, worktreePath, params.base_branch],
    mainWorktree,
  );

  return {
    branch,
    worktree_path: worktreePath,
  };
}

export async function removeWorktree(
  params: RemoveWorktreeParams,
): Promise<WorktreeResult> {
  const branch = validateWorkspaceName(params.workspace_name);
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  const worktreePath = buildWorktreePath(params.repo, branch);

  await ensureMainWorktree(mainWorktree);

  const registeredWorktrees = await listRegisteredWorktrees(mainWorktree);
  if (!registeredWorktrees.includes(worktreePath)) {
    throw new GitWorktreeError(
      "WORKTREE_MISSING",
      `Worktree does not exist at ${worktreePath}`,
    );
  }

  await runGit(["worktree", "remove", worktreePath], mainWorktree);

  return {
    branch,
    worktree_path: worktreePath,
  };
}
