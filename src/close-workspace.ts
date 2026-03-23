import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PitchConfig, RepoConfig } from "./config.js";
import { removeWorktree } from "./git.js";
import { killTmuxWindow } from "./tmux.js";
import {
  deleteWorkspaceRecord,
  readWorkspaceRecord,
  WorkspaceRecordSchema,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from "./workspace-state.js";

export const CloseWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  cleanup_worktree: z.boolean().optional(),
}).strict();

export type CloseWorkspaceInput = z.infer<typeof CloseWorkspaceInputSchema>;

export interface CloseWorkspaceDependencies {
  deleteWorkspaceRecord: typeof deleteWorkspaceRecord;
  killTmuxWindow: typeof killTmuxWindow;
  readWorkspaceRecord: typeof readWorkspaceRecord;
  writeWorkspaceRecord: typeof writeWorkspaceRecord;
  removeWorktree: typeof removeWorktree;
  now: () => Date;
}

const defaultDependencies: CloseWorkspaceDependencies = {
  deleteWorkspaceRecord,
  killTmuxWindow,
  readWorkspaceRecord,
  writeWorkspaceRecord,
  removeWorktree,
  now: () => new Date(),
};

export class CloseWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloseWorkspaceError";
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

function validateInput(params: CloseWorkspaceInput): CloseWorkspaceInput {
  const result = CloseWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new CloseWorkspaceError(
      `Invalid close_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function resolveRepoConfig(config: PitchConfig, repoName: string): RepoConfig {
  const repoConfig = config.repos[repoName];
  if (repoConfig === undefined) {
    throw new CloseWorkspaceError(`Repo is not configured: ${repoName}`);
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

export async function closeWorkspace(
  params: CloseWorkspaceInput,
  config: PitchConfig,
  dependencyOverrides: Partial<CloseWorkspaceDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateInput(params);
  const dependencies: CloseWorkspaceDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  let existingWorkspace: WorkspaceRecord | null;
  try {
    existingWorkspace = await dependencies.readWorkspaceRecord(input.name);
  } catch (error: unknown) {
    throw new CloseWorkspaceError(
      `Failed to read workspace "${input.name}": ${formatError(error)}`,
    );
  }

  if (existingWorkspace === null) {
    throw new CloseWorkspaceError(`Workspace not found: ${input.name}`);
  }

  if (existingWorkspace.status === "closed") {
    throw new CloseWorkspaceError(`Workspace already closed: ${input.name}`);
  }

  const closedAt = dependencies.now().toISOString();
  const closedWorkspace = buildClosedWorkspaceRecord(existingWorkspace, closedAt);
  const shouldCleanupWorktree = input.cleanup_worktree ?? true;
  const repoConfig: RepoConfig | undefined = shouldCleanupWorktree
    ? resolveRepoConfig(config, existingWorkspace.repo)
    : undefined;

  try {
    await dependencies.killTmuxWindow({
      session_name: existingWorkspace.tmux_session,
      window_name: existingWorkspace.tmux_window,
    });
  } catch (error: unknown) {
    throw new CloseWorkspaceError(
      `Failed to close tmux window for ${input.name}: ${formatError(error)}`,
    );
  }

  if (!shouldCleanupWorktree) {
    try {
      return await dependencies.writeWorkspaceRecord(closedWorkspace);
    } catch (error: unknown) {
      throw new CloseWorkspaceError(
        `Failed to update workspace state for ${input.name}: ${formatError(error)}`,
      );
    }
  }

  if (repoConfig === undefined) {
    throw new CloseWorkspaceError(
      `Internal error: missing repo config for ${existingWorkspace.repo}`,
    );
  }

  try {
    await dependencies.removeWorktree({
      repo: repoConfig,
      workspace_name: existingWorkspace.name,
    });
  } catch (error: unknown) {
    try {
      await dependencies.writeWorkspaceRecord(closedWorkspace);
    } catch (fallbackError: unknown) {
      throw new CloseWorkspaceError(
        `Failed to clean up worktree for ${input.name}: ${formatError(error)}\n` +
          `Fallback state write also failed: ${formatError(fallbackError)}`,
      );
    }

    throw new CloseWorkspaceError(
      `Failed to clean up worktree for ${input.name}: ${formatError(error)}`,
    );
  }

  try {
    await dependencies.deleteWorkspaceRecord(existingWorkspace.name);
    return closedWorkspace;
  } catch (error: unknown) {
    try {
      await dependencies.writeWorkspaceRecord(closedWorkspace);
    } catch (fallbackError: unknown) {
      throw new CloseWorkspaceError(
        `Failed to delete workspace state for ${input.name}: ${formatError(error)}\n` +
          `Fallback state write also failed: ${formatError(fallbackError)}`,
      );
    }

    throw new CloseWorkspaceError(
      `Failed to delete workspace state for ${input.name}: ${formatError(error)}`,
    );
  }
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
        "Close a workspace by tearing down its tmux window and, by default, removing its git worktree and state file.",
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
