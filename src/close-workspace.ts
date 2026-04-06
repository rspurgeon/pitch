import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { removeCodexTrustedPath } from "./codex-trust.js";
import type { PitchConfig, RepoConfig } from "./config.js";
import {
  deriveAgentPaneProcess,
  isVmAgentActiveOnHost,
  resolveExecutionEnvironment,
  resolveWorkspacePaths,
} from "./execution-environment.js";
import {
  deleteBranchIfEmpty,
  GitWorktreeError,
  isWorktreeDirty,
  removeWorktree,
} from "./git.js";
import {
  getTmuxWindowPaneInfo,
  killTmuxWindow,
  sendKeysToPane,
} from "./tmux.js";
import {
  deleteWorkspaceRecord,
  getWorkspaceWorktreeName,
  listWorkspaceRecords,
  readWorkspaceRecord,
  WorkspaceRecordSchema,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from "./workspace-state.js";
import { deleteOpencodeConfig } from "./opencode-config.js";
import { buildWorkspaceToolResponse } from "./workspace-tool-response.js";

export const CloseWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
}).strict();

export const DeleteWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  force: z.boolean().optional(),
  delete_branch_if_empty: z.boolean().optional(),
}).strict();

export type CloseWorkspaceInput = z.infer<typeof CloseWorkspaceInputSchema>;
export type DeleteWorkspaceInput = z.infer<typeof DeleteWorkspaceInputSchema>;

export interface WorkspaceLifecycleDependencies {
  deleteBranchIfEmpty: typeof deleteBranchIfEmpty;
  deleteOpencodeConfig: typeof deleteOpencodeConfig;
  deleteWorkspaceRecord: typeof deleteWorkspaceRecord;
  getTmuxWindowPaneInfo: typeof getTmuxWindowPaneInfo;
  isWorktreeDirty: typeof isWorktreeDirty;
  killTmuxWindow: typeof killTmuxWindow;
  listWorkspaceRecords: typeof listWorkspaceRecords;
  readWorkspaceRecord: typeof readWorkspaceRecord;
  removeCodexTrustedPath: typeof removeCodexTrustedPath;
  removeWorktree: typeof removeWorktree;
  sendKeysToPane: typeof sendKeysToPane;
  writeWorkspaceRecord: typeof writeWorkspaceRecord;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  reportWarning?: (warning: string) => void;
}

export type CloseWorkspaceDependencies = WorkspaceLifecycleDependencies;
export type DeleteWorkspaceDependencies = WorkspaceLifecycleDependencies;

const defaultDependencies: WorkspaceLifecycleDependencies = {
  deleteBranchIfEmpty,
  deleteOpencodeConfig,
  deleteWorkspaceRecord,
  getTmuxWindowPaneInfo,
  isWorktreeDirty,
  killTmuxWindow,
  listWorkspaceRecords,
  readWorkspaceRecord,
  removeCodexTrustedPath,
  removeWorktree,
  sendKeysToPane,
  writeWorkspaceRecord,
  sleep: async (milliseconds: number) => {
    await delay(milliseconds);
  },
  now: () => new Date(),
};

export class CloseWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseWorkspaceError";
  }
}

export class DeleteWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeleteWorkspaceError";
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function reportWarnings(
  reportWarning: ((warning: string) => void) | undefined,
  warnings: string[],
): void {
  if (reportWarning === undefined) {
    return;
  }

  for (const warning of warnings) {
    reportWarning(warning);
  }
}

function validateCloseInput(params: CloseWorkspaceInput): CloseWorkspaceInput {
  const result = CloseWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new CloseWorkspaceError(
      `Invalid close_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function validateDeleteInput(
  params: DeleteWorkspaceInput,
): DeleteWorkspaceInput {
  const result = DeleteWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new DeleteWorkspaceError(
      `Invalid delete_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function resolveRepoConfig(config: PitchConfig, repoName: string): RepoConfig {
  const repoConfig = config.repos[repoName];
  if (repoConfig === undefined) {
    throw new Error(`Repo is not configured: ${repoName}`);
  }

  return repoConfig;
}

function buildClosedWorkspaceRecord(
  workspace: WorkspaceRecord,
  closedAt: string,
): WorkspaceRecord {
  return {
    ...workspace,
    status: "closed",
    updated_at: closedAt,
  };
}

function isMissingWorktreeError(error: unknown): boolean {
  return error instanceof GitWorktreeError && error.code === "WORKTREE_MISSING";
}

function sharesWorktree(
  candidate: WorkspaceRecord,
  workspace: WorkspaceRecord,
): boolean {
  return (
    candidate.name !== workspace.name &&
    candidate.repo === workspace.repo &&
    (
      getWorkspaceWorktreeName(candidate) ===
        getWorkspaceWorktreeName(workspace) ||
      candidate.worktree_path === workspace.worktree_path
    )
  );
}

async function hasSharedWorktreeReferences(
  workspace: WorkspaceRecord,
  dependencies: WorkspaceLifecycleDependencies,
): Promise<boolean> {
  const workspaces = await dependencies.listWorkspaceRecords({
    repo: workspace.repo,
    status: "all",
  });
  return workspaces.some((candidate) => sharesWorktree(candidate, workspace));
}

const SHELL_COMMANDS = new Set([
  "ash",
  "bash",
  "dash",
  "fish",
  "ksh",
  "nu",
  "sh",
  "zsh",
]);

async function tryGracefulAgentShutdown(
  workspace: WorkspaceRecord,
  dependencies: WorkspaceLifecycleDependencies,
): Promise<void> {
  let paneInfo;

  try {
    paneInfo = await dependencies.getTmuxWindowPaneInfo({
      session_name: workspace.tmux_session,
      window_name: workspace.tmux_window,
      pane_index: 0,
    });
  } catch {
    return;
  }

  const expectedPaneProcess =
    workspace.agent_pane_process ??
    deriveAgentPaneProcess(
      workspace.agent_type,
      workspace.environment_kind ?? "host",
    );

  if (paneInfo.current_command !== expectedPaneProcess) {
    return;
  }

  if (
    workspace.environment_kind === "vm-ssh" &&
    !(await isVmAgentActiveOnHost(workspace.worktree_path, workspace.name))
  ) {
    return;
  }

  try {
    await dependencies.sendKeysToPane({
      pane_id: paneInfo.pane_id,
      command: "C-c",
      enter: false,
    });
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await dependencies.sleep(100);

    try {
      const updatedPaneInfo = await dependencies.getTmuxWindowPaneInfo({
        session_name: workspace.tmux_session,
        window_name: workspace.tmux_window,
        pane_index: 0,
      });

      if (workspace.environment_kind === "vm-ssh") {
        if (!(await isVmAgentActiveOnHost(workspace.worktree_path, workspace.name))) {
          return;
        }
      } else if (SHELL_COMMANDS.has(updatedPaneInfo.current_command)) {
        return;
      }
    } catch {
      return;
    }
  }
}

async function closeActiveWorkspaceSession(
  workspace: WorkspaceRecord,
  dependencies: WorkspaceLifecycleDependencies,
): Promise<void> {
  if (workspace.status === "closed") {
    return;
  }

  await tryGracefulAgentShutdown(workspace, dependencies);

  try {
    await dependencies.killTmuxWindow({
      session_name: workspace.tmux_session,
      window_name: workspace.tmux_window,
    });
  } catch (error: unknown) {
    throw new Error(
      `Failed to close tmux window for ${workspace.name}: ${formatError(error)}`,
    );
  }
}

async function maybeRemoveCodexTrustedPath(
  workspace: WorkspaceRecord,
  config: PitchConfig,
  dependencies: WorkspaceLifecycleDependencies,
): Promise<void> {
  if (workspace.agent_type !== "codex") {
    return;
  }

  try {
    const environment =
      workspace.environment_name !== null &&
      workspace.environment_name !== undefined
        ? resolveExecutionEnvironment(
            config,
            workspace.repo,
            workspace.environment_name,
          )
        : { kind: workspace.environment_kind ?? "host" };
    const workspacePaths = resolveWorkspacePaths(
      environment,
      getWorkspaceWorktreeName(workspace),
      workspace.worktree_path,
    );
    workspacePaths.agent_worktree_path =
      workspace.guest_worktree_path ?? workspacePaths.agent_worktree_path;
    workspacePaths.guest_worktree_path =
      workspace.guest_worktree_path ?? workspacePaths.guest_worktree_path;

    await dependencies.removeCodexTrustedPath({
      environment,
      workspace_paths: workspacePaths,
      codex_home: workspace.agent_env.CODEX_HOME,
    });
  } catch {
    // best-effort cleanup only
  }
}

async function readWorkspaceOrThrow(
  name: string,
  dependencies: WorkspaceLifecycleDependencies,
  ErrorCtor: typeof CloseWorkspaceError | typeof DeleteWorkspaceError,
): Promise<WorkspaceRecord> {
  let workspace: WorkspaceRecord | null;
  try {
    workspace = await dependencies.readWorkspaceRecord(name);
  } catch (error: unknown) {
    throw new ErrorCtor(
      `Failed to read workspace "${name}": ${formatError(error)}`,
    );
  }

  if (workspace === null) {
    throw new ErrorCtor(`Workspace not found: ${name}`);
  }

  return workspace;
}

export async function closeWorkspace(
  params: CloseWorkspaceInput,
  config: PitchConfig,
  dependencyOverrides: Partial<CloseWorkspaceDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateCloseInput(params);
  const dependencies: CloseWorkspaceDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const existingWorkspace = await readWorkspaceOrThrow(
    input.name,
    dependencies,
    CloseWorkspaceError,
  );

  if (existingWorkspace.status === "closed") {
    return existingWorkspace;
  }

  try {
    await closeActiveWorkspaceSession(existingWorkspace, dependencies);
  } catch (error: unknown) {
    throw new CloseWorkspaceError(formatError(error));
  }

  const closedWorkspace = buildClosedWorkspaceRecord(
    existingWorkspace,
    dependencies.now().toISOString(),
  );

  try {
    return await dependencies.writeWorkspaceRecord(closedWorkspace);
  } catch (error: unknown) {
    throw new CloseWorkspaceError(
      `Failed to update workspace state for ${input.name}: ${formatError(error)}`,
    );
  }
}

async function ensureWorktreeDeletable(
  workspace: WorkspaceRecord,
  force: boolean,
  dependencies: WorkspaceLifecycleDependencies,
): Promise<void> {
  if (force) {
    return;
  }

  let isDirty: boolean;
  try {
    isDirty = await dependencies.isWorktreeDirty(workspace.worktree_path);
  } catch (error: unknown) {
    throw new DeleteWorkspaceError(
      `Failed to inspect worktree for ${workspace.name}: ${formatError(error)}`,
    );
  }

  if (isDirty) {
    throw new DeleteWorkspaceError(
      `Worktree ${workspace.worktree_path} contains modified or untracked files; rerun with --force to delete it.`,
    );
  }
}

async function deleteWorkspaceState(
  name: string,
  dependencies: WorkspaceLifecycleDependencies,
): Promise<void> {
  try {
    await dependencies.deleteWorkspaceRecord(name);
  } catch (error: unknown) {
    throw new DeleteWorkspaceError(
      `Failed to delete workspace state for ${name}: ${formatError(error)}`,
    );
  }
}

async function maybeDeleteWorkspaceBranch(
  workspace: WorkspaceRecord,
  input: DeleteWorkspaceInput,
  repoConfig: RepoConfig | null,
  hasSharedReferences: boolean,
  dependencies: WorkspaceLifecycleDependencies,
): Promise<void> {
  if (input.delete_branch_if_empty !== true) {
    return;
  }

  if (workspace.source_kind === "pr") {
    reportWarnings(dependencies.reportWarning, [
      `Skipping local branch deletion for ${workspace.branch}: PR workspaces do not delete branches automatically.`,
    ]);
    return;
  }

  if (hasSharedReferences) {
    reportWarnings(dependencies.reportWarning, [
      `Skipping local branch deletion for ${workspace.branch}: another workspace still references this checkout.`,
    ]);
    return;
  }

  if (repoConfig === null) {
    reportWarnings(dependencies.reportWarning, [
      `Skipping local branch deletion for ${workspace.branch}: repo configuration is unavailable.`,
    ]);
    return;
  }

  try {
    const result = await dependencies.deleteBranchIfEmpty({
      repo: repoConfig,
      branch: workspace.branch,
      base_branch: workspace.base_branch,
    });
    if (!result.deleted && result.reason !== undefined) {
      reportWarnings(dependencies.reportWarning, [result.reason]);
    }
  } catch (error: unknown) {
    reportWarnings(dependencies.reportWarning, [
      `Failed to evaluate local branch deletion for ${workspace.branch}: ${formatError(error)}`,
    ]);
  }
}

export async function deleteWorkspace(
  params: DeleteWorkspaceInput,
  config: PitchConfig,
  dependencyOverrides: Partial<DeleteWorkspaceDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateDeleteInput(params);
  const dependencies: DeleteWorkspaceDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const existingWorkspace = await readWorkspaceOrThrow(
    input.name,
    dependencies,
    DeleteWorkspaceError,
  );
  const closedWorkspace =
    existingWorkspace.status === "closed"
      ? existingWorkspace
      : buildClosedWorkspaceRecord(
          existingWorkspace,
          dependencies.now().toISOString(),
        );

  let hasSharedReferences: boolean;
  try {
    hasSharedReferences = await hasSharedWorktreeReferences(
      existingWorkspace,
      dependencies,
    );
  } catch (error: unknown) {
    throw new DeleteWorkspaceError(
      `Failed to inspect shared worktree usage for ${input.name}: ${formatError(error)}`,
    );
  }

  if (!hasSharedReferences) {
    await ensureWorktreeDeletable(
      existingWorkspace,
      input.force === true,
      dependencies,
    );
  }

  if (existingWorkspace.status !== "closed") {
    try {
      await closeActiveWorkspaceSession(existingWorkspace, dependencies);
    } catch (error: unknown) {
      throw new DeleteWorkspaceError(formatError(error));
    }

    try {
      await dependencies.writeWorkspaceRecord(closedWorkspace);
    } catch (error: unknown) {
      throw new DeleteWorkspaceError(
        `Failed to update workspace state for ${input.name}: ${formatError(error)}`,
      );
    }
  }

  try {
    await dependencies.deleteOpencodeConfig(existingWorkspace.name);
  } catch {
    // best-effort cleanup only
  }

  if (hasSharedReferences) {
    await maybeDeleteWorkspaceBranch(
      existingWorkspace,
      input,
      null,
      true,
      dependencies,
    );
    await deleteWorkspaceState(existingWorkspace.name, dependencies);
    return closedWorkspace;
  }

  let repoConfig: RepoConfig;
  try {
    repoConfig = resolveRepoConfig(config, existingWorkspace.repo);
  } catch (error: unknown) {
    throw new DeleteWorkspaceError(formatError(error));
  }

  await maybeRemoveCodexTrustedPath(existingWorkspace, config, dependencies);

  try {
    await dependencies.removeWorktree({
      repo: repoConfig,
      workspace_name: getWorkspaceWorktreeName(existingWorkspace),
      worktree_path: existingWorkspace.worktree_path,
      ...(input.force === true ? { force: true } : {}),
    });
  } catch (error: unknown) {
    if (!isMissingWorktreeError(error)) {
      throw new DeleteWorkspaceError(
        `Failed to remove worktree for ${input.name}: ${formatError(error)}`,
      );
    }
  }

  await maybeDeleteWorkspaceBranch(
    existingWorkspace,
    input,
    repoConfig,
    false,
    dependencies,
  );

  await deleteWorkspaceState(existingWorkspace.name, dependencies);
  return closedWorkspace;
}

export function registerCloseWorkspaceTool(
  server: McpServer,
  config: PitchConfig,
  dependencies: Partial<CloseWorkspaceDependencies> = {},
): void {
  server.registerTool(
    "close_workspace",
    {
      description:
        "Close a workspace by tearing down its tmux window and marking it closed. Worktree cleanup is handled by delete_workspace.",
      inputSchema: CloseWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args) => {
      const workspace = await closeWorkspace(args, config, dependencies);
      return {
        content: [{ type: "text", text: JSON.stringify(workspace) }],
        structuredContent: workspace,
      };
    },
  );
}

export function registerDeleteWorkspaceTool(
  server: McpServer,
  config: PitchConfig,
  dependencies: Partial<DeleteWorkspaceDependencies> = {},
): void {
  server.registerTool(
    "delete_workspace",
    {
      description:
        "Delete a workspace by removing its state file and, when applicable, its git worktree. Refuses dirty worktrees unless force is set.",
      inputSchema: DeleteWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args) => {
      const warnings: string[] = [];
      const workspace = await deleteWorkspace(args, config, {
        ...dependencies,
        reportWarning: (warning) => warnings.push(warning),
      });
      return buildWorkspaceToolResponse(workspace, warnings);
    },
  );
}
