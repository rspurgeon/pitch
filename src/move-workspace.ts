import { z } from "zod";
import type { PitchConfig } from "./config.js";
import {
  ensureTmuxSession,
  linkTmuxWindow,
  tmuxWindowExists,
  unlinkTmuxWindow,
} from "./tmux.js";
import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  WorkspaceRecordSchema,
  type WorkspaceRecord,
} from "./workspace-state.js";
import { buildWorkspaceToolResponse } from "./workspace-tool-response.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MoveWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  tmux_session: z.string().trim().min(1),
}).strict();

export type MoveWorkspaceInput = z.infer<typeof MoveWorkspaceInputSchema>;

export interface MoveWorkspaceDependencies {
  ensureTmuxSession: typeof ensureTmuxSession;
  linkTmuxWindow: typeof linkTmuxWindow;
  readWorkspaceRecord: typeof readWorkspaceRecord;
  tmuxWindowExists: typeof tmuxWindowExists;
  unlinkTmuxWindow: typeof unlinkTmuxWindow;
  writeWorkspaceRecord: typeof writeWorkspaceRecord;
  now: () => Date;
  reportWarning?: (warning: string) => void;
}

const defaultDependencies: MoveWorkspaceDependencies = {
  ensureTmuxSession,
  linkTmuxWindow,
  readWorkspaceRecord,
  tmuxWindowExists,
  unlinkTmuxWindow,
  writeWorkspaceRecord,
  now: () => new Date(),
};

export class MoveWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoveWorkspaceError";
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

function validateInput(params: MoveWorkspaceInput): MoveWorkspaceInput {
  const result = MoveWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new MoveWorkspaceError(
      `Invalid move_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

async function readWorkspaceOrThrow(
  name: string,
  dependencies: MoveWorkspaceDependencies,
): Promise<WorkspaceRecord> {
  let workspace: WorkspaceRecord | null;
  try {
    workspace = await dependencies.readWorkspaceRecord(name);
  } catch (error: unknown) {
    throw new MoveWorkspaceError(
      `Failed to read workspace "${name}": ${formatError(error)}`,
    );
  }

  if (workspace === null) {
    throw new MoveWorkspaceError(`Workspace not found: ${name}`);
  }

  return workspace;
}

async function rollbackLinkedWindow(
  workspace: WorkspaceRecord,
  targetSession: string,
  dependencies: MoveWorkspaceDependencies,
): Promise<string | null> {
  try {
    await dependencies.unlinkTmuxWindow({
      session_name: targetSession,
      window_name: workspace.tmux_window,
    });
    return null;
  } catch (error: unknown) {
    return `Rollback failed to unlink ${targetSession}:${workspace.tmux_window}: ${formatError(error)}`;
  }
}

export async function moveWorkspace(
  params: MoveWorkspaceInput,
  _config: PitchConfig,
  dependencyOverrides: Partial<MoveWorkspaceDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateInput(params);
  const dependencies: MoveWorkspaceDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const workspace = await readWorkspaceOrThrow(input.name, dependencies);

  if (workspace.tmux_session === input.tmux_session) {
    return workspace;
  }

  const movedWorkspace: WorkspaceRecord = {
    ...workspace,
    tmux_session: input.tmux_session,
    updated_at: dependencies.now().toISOString(),
  };

  if (workspace.status === "closed") {
    try {
      return await dependencies.writeWorkspaceRecord(movedWorkspace);
    } catch (error: unknown) {
      throw new MoveWorkspaceError(
        `Failed to update workspace state for ${workspace.name}: ${formatError(error)}`,
      );
    }
  }

  let sourceExists: boolean;
  try {
    sourceExists = await dependencies.tmuxWindowExists(
      workspace.tmux_session,
      workspace.tmux_window,
    );
  } catch (error: unknown) {
    throw new MoveWorkspaceError(
      `Failed to inspect source tmux window ${workspace.tmux_session}:${workspace.tmux_window}: ${formatError(error)}`,
    );
  }

  if (!sourceExists) {
    throw new MoveWorkspaceError(
      `Source tmux window not found: ${workspace.tmux_session}:${workspace.tmux_window}`,
    );
  }

  try {
    await dependencies.ensureTmuxSession({
      session_name: input.tmux_session,
      start_directory: workspace.worktree_path,
    });
  } catch (error: unknown) {
    throw new MoveWorkspaceError(
      `Failed to ensure target tmux session ${input.tmux_session}: ${formatError(error)}`,
    );
  }

  let targetExists: boolean;
  try {
    targetExists = await dependencies.tmuxWindowExists(
      input.tmux_session,
      workspace.tmux_window,
    );
  } catch (error: unknown) {
    throw new MoveWorkspaceError(
      `Failed to inspect target tmux window ${input.tmux_session}:${workspace.tmux_window}: ${formatError(error)}`,
    );
  }

  if (targetExists) {
    throw new MoveWorkspaceError(
      `Target tmux window already exists: ${input.tmux_session}:${workspace.tmux_window}`,
    );
  }

  try {
    await dependencies.linkTmuxWindow({
      source_session_name: workspace.tmux_session,
      source_window_name: workspace.tmux_window,
      target_session_name: input.tmux_session,
    });
  } catch (error: unknown) {
    throw new MoveWorkspaceError(
      `Failed to link tmux window ${workspace.tmux_session}:${workspace.tmux_window} to ${input.tmux_session}: ${formatError(error)}`,
    );
  }

  try {
    const persistedWorkspace =
      await dependencies.writeWorkspaceRecord(movedWorkspace);
    try {
      await dependencies.unlinkTmuxWindow({
        session_name: workspace.tmux_session,
        window_name: workspace.tmux_window,
      });
    } catch (error: unknown) {
      dependencies.reportWarning?.(
        `Workspace state was updated, but failed to unlink old tmux window ${workspace.tmux_session}:${workspace.tmux_window}: ${formatError(error)}`,
      );
    }

    return persistedWorkspace;
  } catch (error: unknown) {
    const rollbackError = await rollbackLinkedWindow(
      workspace,
      input.tmux_session,
      dependencies,
    );
    const rollbackMessage =
      rollbackError === null ? "" : `\n${rollbackError}`;
    throw new MoveWorkspaceError(
      `Failed to update workspace state for ${workspace.name}: ${formatError(error)}${rollbackMessage}`,
    );
  }
}

export function registerMoveWorkspaceTool(
  server: McpServer,
  config: PitchConfig,
  dependencies: Partial<MoveWorkspaceDependencies> = {},
): void {
  server.registerTool(
    "move_workspace",
    {
      description:
        "Move a tracked workspace tmux window to another tmux session and update the workspace state.",
      inputSchema: MoveWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args) => {
      const warnings: string[] = [];
      const workspace = await moveWorkspace(args, config, {
        ...dependencies,
        reportWarning: (warning) => warnings.push(warning),
      });
      return buildWorkspaceToolResponse(workspace, warnings);
    },
  );
}
