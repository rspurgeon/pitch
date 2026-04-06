import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
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
  allow_branch_reuse?: boolean;
}

export interface RemoveWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
  worktree_path?: string;
  force?: boolean;
}

export interface RestoreWorktreeParams {
  repo: GitRepoConfig;
  workspace_name: string;
  branch: string;
  allow_branch_reuse?: boolean;
}

export interface DeleteBranchIfEmptyParams {
  repo: Pick<GitRepoConfig, "main_worktree">;
  branch: string;
  base_branch: string;
}

export interface FetchGitRefParams {
  repo: Pick<GitRepoConfig, "main_worktree">;
  remote: string;
  fallback_remote?: string;
  source_ref: string;
  destination_ref: string;
}

export interface FastForwardWorktreeParams {
  worktree_path: string;
  target_ref: string;
}

export interface WorktreeResult {
  branch: string;
  worktree_path: string;
}

export interface ManagedWorktreeMatch extends WorktreeResult {
  workspace_name: string;
}

export interface EnsuredWorktreeResult extends WorktreeResult {
  adopted: boolean;
}

export interface DeleteBranchIfEmptyResult {
  deleted: boolean;
  reason?: string;
}

type GitWorktreeErrorCode =
  | "MAIN_WORKTREE_MISSING"
  | "INVALID_MAIN_WORKTREE"
  | "INVALID_WORKSPACE_NAME"
  | "INVALID_BRANCH_NAME"
  | "BRANCH_IN_USE"
  | "BRANCH_MISSING"
  | "BRANCH_EXISTS"
  | "WORKTREE_EXISTS"
  | "WORKTREE_MISSING"
  | "INVALID_WORKTREE_PATH"
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

function isBranchInUseError(error: unknown): boolean {
  return formatGitError(error).includes("is already used by worktree at");
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

async function isRegisteredWorktree(
  mainWorktree: string,
  worktreePath: string,
): Promise<boolean> {
  const normalizedTarget = await normalizePath(worktreePath);
  const registeredWorktrees = await listRegisteredWorktrees(mainWorktree);
  const normalizedRegistered = await Promise.all(
    registeredWorktrees.map((path) => normalizePath(path)),
  );

  return normalizedRegistered.includes(normalizedTarget);
}

async function listRegisteredWorktreeDetails(
  mainWorktree: string,
): Promise<Array<{ worktree_path: string; branch: string | null }>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: mainWorktree },
    );

    const entries: Array<{ worktree_path: string; branch: string | null }> = [];
    let currentPath: string | null = null;
    let currentBranch: string | null = null;

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentPath !== null) {
          entries.push({
            worktree_path: currentPath,
            branch: currentBranch,
          });
        }
        currentPath = line.slice("worktree ".length).trim();
        currentBranch = null;
        continue;
      }

      if (line.startsWith("branch ")) {
        const branchRef = line.slice("branch ".length).trim();
        currentBranch = branchRef.startsWith("refs/heads/")
          ? branchRef.slice("refs/heads/".length)
          : branchRef;
      }
    }

    if (currentPath !== null) {
      entries.push({
        worktree_path: currentPath,
        branch: currentBranch,
      });
    }

    return entries;
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to list registered worktrees in ${mainWorktree}\n${formatGitError(err)}`,
    );
  }
}

function toWorkspaceNameFromManagedPath(
  worktreeBase: string,
  worktreePath: string,
): string | null {
  const relativePath = relative(worktreeBase, worktreePath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    relativePath.includes(sep)
  ) {
    return null;
  }

  try {
    return validateWorkspaceName(relativePath);
  } catch {
    return null;
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
  try {
    await runGit(
      ["worktree", "add", "-b", branch, worktreePath, params.start_point],
      mainWorktree,
    );
  } catch (error: unknown) {
    if (isBranchInUseError(error)) {
      throw new GitWorktreeError(
        "BRANCH_IN_USE",
        `Branch is already checked out in another worktree: ${branch}`,
      );
    }

    throw error;
  }

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
      allow_branch_reuse: params.allow_branch_reuse,
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

export async function findManagedWorktreeForBranch(
  repo: GitRepoConfig,
  branch: string,
): Promise<ManagedWorktreeMatch | null> {
  const mainWorktree = expandHomePath(repo.main_worktree);
  const worktreeBase = expandHomePath(repo.worktree_base);

  await ensureMainWorktree(mainWorktree);
  await ensureValidBranchName(mainWorktree, branch);

  const normalizedWorktreeBase = await normalizePath(worktreeBase);
  const worktrees = await listRegisteredWorktreeDetails(mainWorktree);

  for (const worktree of worktrees) {
    if (worktree.branch !== branch) {
      continue;
    }

    const normalizedWorktreePath = await normalizePath(worktree.worktree_path);
    const workspaceName = toWorkspaceNameFromManagedPath(
      normalizedWorktreeBase,
      normalizedWorktreePath,
    );

    if (workspaceName === null) {
      continue;
    }

    return {
      workspace_name: workspaceName,
      branch,
      worktree_path: join(worktreeBase, workspaceName),
    };
  }

  return null;
}

export async function listWorktreesForBranch(
  repo: Pick<GitRepoConfig, "main_worktree">,
  branch: string,
): Promise<WorktreeResult[]> {
  const mainWorktree = expandHomePath(repo.main_worktree);

  await ensureMainWorktree(mainWorktree);
  await ensureValidBranchName(mainWorktree, branch);

  const worktrees = await listRegisteredWorktreeDetails(mainWorktree);
  return worktrees
    .filter((worktree) => worktree.branch === branch)
    .map((worktree) => ({
      branch,
      worktree_path: worktree.worktree_path,
    }));
}

async function hasRemoteTrackingBranch(
  mainWorktree: string,
  branch: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
      { cwd: mainWorktree },
    );

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .some((ref) => ref.endsWith(`/${branch}`));
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to inspect remote-tracking branches for ${branch}\n${formatGitError(err)}`,
    );
  }
}

async function countUniqueBranchCommits(
  mainWorktree: string,
  baseBranch: string,
  branch: string,
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--right-only", "--count", `${baseBranch}...${branch}`],
      { cwd: mainWorktree },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Unexpected rev-list count: ${stdout.trim()}`);
    }

    return parsed;
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to compare branch ${branch} against ${baseBranch}\n${formatGitError(err)}`,
    );
  }
}

export async function deleteBranchIfEmpty(
  params: DeleteBranchIfEmptyParams,
): Promise<DeleteBranchIfEmptyResult> {
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  await ensureMainWorktree(mainWorktree);

  const branch = await ensureValidBranchName(mainWorktree, params.branch);
  const baseBranch = await ensureValidBranchName(mainWorktree, params.base_branch);

  if (branch === baseBranch) {
    return {
      deleted: false,
      reason: `Skipping local branch deletion for ${branch}: branch matches base branch ${baseBranch}.`,
    };
  }

  if (!(await branchExists(mainWorktree, branch))) {
    return {
      deleted: false,
      reason: `Skipping local branch deletion for ${branch}: local branch does not exist.`,
    };
  }

  if (!(await branchExists(mainWorktree, baseBranch))) {
    return {
      deleted: false,
      reason: `Skipping local branch deletion for ${branch}: base branch ${baseBranch} does not exist locally.`,
    };
  }

  const activeWorktrees = await listWorktreesForBranch(
    { main_worktree: mainWorktree },
    branch,
  );
  if (activeWorktrees.length > 0) {
    return {
      deleted: false,
      reason: `Skipping local branch deletion for ${branch}: branch is still checked out in another worktree.`,
    };
  }

  if (await hasRemoteTrackingBranch(mainWorktree, branch)) {
    return {
      deleted: false,
      reason: `Skipping local branch deletion for ${branch}: a remote-tracking ref exists, so the branch may have been pushed.`,
    };
  }

  if ((await countUniqueBranchCommits(mainWorktree, baseBranch, branch)) > 0) {
    return {
      deleted: false,
      reason: `Skipping local branch deletion for ${branch}: branch has commits not contained in ${baseBranch}.`,
    };
  }

  try {
    await execFileAsync("git", ["branch", "-D", branch], {
      cwd: mainWorktree,
    });
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to delete local branch ${branch}\n${formatGitError(err)}`,
    );
  }

  return {
    deleted: true,
  };
}

export async function removeWorktree(
  params: RemoveWorktreeParams,
): Promise<WorktreeResult> {
  const workspaceName = validateWorkspaceName(params.workspace_name);
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  const expectedWorktreePath = buildWorktreePath(params.repo, workspaceName);
  const worktreePath = params.worktree_path === undefined
    ? expectedWorktreePath
    : expandHomePath(params.worktree_path);

  await ensureMainWorktree(mainWorktree);

  if (params.worktree_path !== undefined) {
    const [normalizedWorktreePath, normalizedExpectedWorktreePath] =
      await Promise.all([
        normalizePath(worktreePath),
        normalizePath(expectedWorktreePath),
      ]);

    if (normalizedWorktreePath !== normalizedExpectedWorktreePath) {
      throw new GitWorktreeError(
        "INVALID_WORKTREE_PATH",
        `Worktree path does not match the managed worktree for ${workspaceName}: ${worktreePath}`,
      );
    }
  }

  if (!(await isRegisteredWorktree(mainWorktree, worktreePath))) {
    throw new GitWorktreeError(
      "WORKTREE_MISSING",
      `Worktree does not exist at ${worktreePath}`,
    );
  }

  let branch = workspaceName;
  if (await pathExists(worktreePath)) {
    try {
      branch = await currentBranch(worktreePath);
    } catch {
      branch = workspaceName;
    }
  }

  const removeArgs = ["worktree", "remove"];
  if (params.force === true) {
    removeArgs.push("--force");
  }
  removeArgs.push(worktreePath);
  await runGit(removeArgs, mainWorktree);

  return {
    branch,
    worktree_path: worktreePath,
  };
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const expandedPath = expandHomePath(worktreePath);
  if (!(await pathExists(expandedPath))) {
    return false;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: expandedPath },
    );
    return stdout.trim().length > 0;
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to inspect worktree status at ${expandedPath}\n${formatGitError(err)}`,
    );
  }
}

export async function fastForwardWorktree(
  params: FastForwardWorktreeParams,
): Promise<void> {
  const worktreePath = expandHomePath(params.worktree_path);

  if (!(await pathExists(worktreePath))) {
    throw new GitWorktreeError(
      "WORKTREE_MISSING",
      `Worktree does not exist at ${worktreePath}`,
    );
  }

  try {
    await execFileAsync(
      "git",
      ["merge", "--ff-only", params.target_ref],
      { cwd: worktreePath },
    );
  } catch (err: unknown) {
    throw new GitWorktreeError(
      "COMMAND_FAILED",
      `Failed to fast-forward worktree at ${worktreePath} to ${params.target_ref}\n${formatGitError(err)}`,
    );
  }
}

export async function fetchGitRef(
  params: FetchGitRefParams,
): Promise<string> {
  const mainWorktree = expandHomePath(params.repo.main_worktree);
  await ensureMainWorktree(mainWorktree);

  const refSpec = `${params.source_ref}:${params.destination_ref}`;

  try {
    await runGit(
      ["fetch", "--no-tags", params.remote, refSpec],
      mainWorktree,
    );
  } catch (primaryError: unknown) {
    if (
      params.fallback_remote === undefined ||
      params.fallback_remote === params.remote
    ) {
      throw primaryError;
    }

    try {
      await runGit(
        ["fetch", "--no-tags", params.fallback_remote, refSpec],
        mainWorktree,
      );
    } catch (fallbackError: unknown) {
      throw new GitWorktreeError(
        "COMMAND_FAILED",
        `Failed to fetch ${params.source_ref} into ${params.destination_ref} via ${params.remote} and fallback remote ${params.fallback_remote}\nPrimary: ${formatGitError(primaryError)}\nFallback: ${formatGitError(fallbackError)}`,
      );
    }
  }

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
  const addArgs = params.allow_branch_reuse === true
    ? ["worktree", "add", "-f", worktreePath, branch]
    : ["worktree", "add", worktreePath, branch];

  try {
    await runGit(addArgs, mainWorktree);
  } catch (error: unknown) {
    if (isBranchInUseError(error)) {
      throw new GitWorktreeError(
        "BRANCH_IN_USE",
        `Branch is already checked out in another worktree: ${branch}`,
      );
    }

    throw error;
  }

  return {
    branch,
    worktree_path: worktreePath,
  };
}
