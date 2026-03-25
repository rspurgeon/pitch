import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type GitRepoConfig = Pick<RepoConfig, "main_worktree" | "worktree_base">;

export interface CreateWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
  branch: string;
  start_point: string;
}

export interface EnsureWorkspaceWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
  branch: string;
  start_point: string;
}

export interface RemoveWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
}

export interface RestoreWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
  branch: string;
}

export interface FetchGitRefParams {
  repo: Pick<GitRepoConfig, "main_worktree">;
  remote: string;
  source_ref: string;
  destination_ref: string;
}

export interface WorktreeResult {
  branch: string;
  worktree_path: string;
}

export interface EnsuredWorktreeResult extends WorktreeResult {
  adopted: boolean;
}

type GitWorktreeErrorCode =
  | "MAIN_WORKTREE_MISSING"
  | "INVALID_MAIN_WORKTREE"
  | "INVALID_WORKSPACE_NAME"
  | "INVALID_BRANCH_NAME"
  | "BRANCH_MISSING"
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

async function normalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
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

async function ensureValidBranchName(
  mainWorktree: string,
  branch: string,
): Promise<string> {
  if (branch.trim().length === 0) {
    throw new GitWorktreeError(
      "INVALID_BRANCH_NAME",
      `Invalid branch name: ${branch}`,
    );
  }

  try {
    await execFileAsync("git", ["check-ref-format", "--branch", branch], {
      cwd: mainWorktree,
    });
  } catch {
    throw new GitWorktreeError(
      "INVALID_BRANCH_NAME",
      `Invalid branch name: ${branch}`,
    );
  }

  return branch;
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

async function currentBranch(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: path },
    );
    return stdout.trim();
  } catch {
    throw new GitWorktreeError(
      "WORKTREE_EXISTS",
      `Existing path is not a usable git worktree at ${path}`,
    );
  }
}

async function ensureAdoptableWorktree(
  mainWorktree: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const normalizedWorktreePath = await normalizePath(worktreePath);
  const registeredWorktrees = await listRegisteredWorktrees(mainWorktree);
  const normalizedRegisteredWorktrees = await Promise.all(
    registeredWorktrees.map((path) => normalizePath(path)),
  );

  if (!normalizedRegisteredWorktrees.includes(normalizedWorktreePath)) {
    throw new GitWorktreeError(
      "WORKTREE_EXISTS",
      `Existing path is not a registered worktree at ${worktreePath}`,
    );
  }

  const activeBranch = await currentBranch(worktreePath);
  if (activeBranch !== branch) {
    throw new GitWorktreeError(
      "WORKTREE_EXISTS",
      `Existing path is not the expected worktree branch at ${worktreePath}`,
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
  const workspaceName = validateWorkspaceName(params.workspace_name);
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  const worktreePath = buildWorktreePath(params.repo, workspaceName);

  await ensureMainWorktree(mainWorktree);
  const branch = await ensureValidBranchName(mainWorktree, params.branch);

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
    ["worktree", "add", "-b", branch, worktreePath, params.start_point],
    mainWorktree,
  );

  return {
    branch,
    worktree_path: worktreePath,
  };
}

export async function ensureWorkspaceWorktree(
  params: EnsureWorkspaceWorktreeParams,
): Promise<EnsuredWorktreeResult> {
  const workspaceName = validateWorkspaceName(params.workspace_name);
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  const worktreePath = buildWorktreePath(params.repo, workspaceName);

  await ensureMainWorktree(mainWorktree);
  const branch = await ensureValidBranchName(mainWorktree, params.branch);

  if (await pathExists(worktreePath)) {
    await ensureAdoptableWorktree(mainWorktree, worktreePath, branch);
    return {
      branch,
      worktree_path: worktreePath,
      adopted: true,
    };
  }

  if (await branchExists(mainWorktree, branch)) {
    const restored = await restoreWorktree({
      repo: params.repo,
      workspace_name: workspaceName,
      branch,
    });
    return {
      ...restored,
      adopted: true,
    };
  }

  const created = await createWorktree(params);
  return {
    ...created,
    adopted: false,
  };
}

export async function removeWorktree(
  params: RemoveWorktreeParams,
): Promise<WorktreeResult> {
  const workspaceName = validateWorkspaceName(params.workspace_name);
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  const worktreePath = buildWorktreePath(params.repo, workspaceName);

  await ensureMainWorktree(mainWorktree);

  const registeredWorktrees = await listRegisteredWorktrees(mainWorktree);
  if (!registeredWorktrees.includes(worktreePath)) {
    throw new GitWorktreeError(
      "WORKTREE_MISSING",
      `Worktree does not exist at ${worktreePath}`,
    );
  }

  const branch = await (await pathExists(worktreePath)
    ? currentBranch(worktreePath)
    : Promise.resolve(workspaceName));
  await runGit(["worktree", "remove", worktreePath], mainWorktree);

  return {
    branch,
    worktree_path: worktreePath,
  };
}

export async function fetchGitRef(
  params: FetchGitRefParams,
): Promise<string> {
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  await ensureMainWorktree(mainWorktree);

  await runGit(
    [
      "fetch",
      "--no-tags",
      params.remote,
      `${params.source_ref}:${params.destination_ref}`,
    ],
    mainWorktree,
  );

  return params.destination_ref;
}

export async function restoreWorktree(
  params: RestoreWorktreeParams,
): Promise<WorktreeResult> {
  const workspaceName = validateWorkspaceName(params.workspace_name);
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  const worktreePath = buildWorktreePath(params.repo, workspaceName);

  await ensureMainWorktree(mainWorktree);
  const branch = await ensureValidBranchName(mainWorktree, params.branch);

  if (await pathExists(worktreePath)) {
    await ensureAdoptableWorktree(mainWorktree, worktreePath, branch);

    return {
      branch,
      worktree_path: worktreePath,
    };
  }

  await runGit(["worktree", "prune"], mainWorktree);

  const registeredWorktrees = await listRegisteredWorktrees(mainWorktree);
  if (registeredWorktrees.includes(worktreePath)) {
    throw new GitWorktreeError(
      "WORKTREE_EXISTS",
      `Worktree already exists at ${worktreePath}`,
    );
  }

  if (!(await branchExists(mainWorktree, branch))) {
    throw new GitWorktreeError(
      "BRANCH_MISSING",
      `Branch does not exist: ${branch}`,
    );
  }

  await mkdir(expandHomePath(params.repo.worktree_base), { recursive: true });
  await runGit(["worktree", "add", worktreePath, branch], mainWorktree);

  return {
    branch,
    worktree_path: worktreePath,
  };
}
