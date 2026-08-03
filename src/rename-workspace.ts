import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PitchConfig } from "./config.js";
import { renameTmuxWindow, tmuxWindowExists } from "./tmux.js";
import {
  deleteWorkspaceRecord,
  getWorkspaceWorktreeName,
  readWorkspaceRecord,
  writeWorkspaceRecord,
  WorkspaceRecordSchema,
  type WorkspaceRecord,
} from "./workspace-state.js";
import { buildWorkspaceToolResponse } from "./workspace-tool-response.js";

const SafeWorkspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (name) =>
      name !== "." &&
      name !== ".." &&
      !name.includes(":") &&
      !name.includes("/") &&
      !name.includes("\\"),
    { message: "Invalid workspace name" },
  );

export const RenameWorkspaceInputSchema = z.object({
  name: SafeWorkspaceNameSchema,
  new_name: SafeWorkspaceNameSchema,
}).strict();

export type RenameWorkspaceInput = z.infer<typeof RenameWorkspaceInputSchema>;

export interface RenameWorkspaceDependencies {
  deleteWorkspaceRecord: typeof deleteWorkspaceRecord;
  readWorkspaceRecord: typeof readWorkspaceRecord;
  renameTmuxWindow: typeof renameTmuxWindow;
  tmuxWindowExists: typeof tmuxWindowExists;
  writeWorkspaceRecord: typeof writeWorkspaceRecord;
  now: () => Date;
}

const defaultDependencies: RenameWorkspaceDependencies = {
  deleteWorkspaceRecord,
  readWorkspaceRecord,
  renameTmuxWindow,
  tmuxWindowExists,
  writeWorkspaceRecord,
  now: () => new Date(),
};

export class RenameWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenameWorkspaceError";
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateInput(params: RenameWorkspaceInput): RenameWorkspaceInput {
  const result = RenameWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new RenameWorkspaceError(
      `Invalid rename_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

async function readWorkspaceOrThrow(
  name: string,
  dependencies: RenameWorkspaceDependencies,
): Promise<WorkspaceRecord> {
  try {
    const workspace = await dependencies.readWorkspaceRecord(name);
    if (workspace === null) {
      throw new RenameWorkspaceError(`Workspace not found: ${name}`);
    }
    return workspace;
  } catch (error: unknown) {
    if (error instanceof RenameWorkspaceError) {
      throw error;
    }
    throw new RenameWorkspaceError(
      `Failed to read workspace "${name}": ${formatError(error)}`,
    );
  }
}

async function rollbackRename(
  workspace: WorkspaceRecord,
  renamedWorkspace: WorkspaceRecord,
  windowRenamed: boolean,
  dependencies: RenameWorkspaceDependencies,
): Promise<string[]> {
  const failures: string[] = [];

  try {
    await dependencies.deleteWorkspaceRecord(renamedWorkspace.name);
  } catch (error: unknown) {
    failures.push(
      `failed to remove new workspace state ${renamedWorkspace.name}: ${formatError(error)}`,
    );
  }

  if (windowRenamed) {
    try {
      await dependencies.renameTmuxWindow({
        session_name: workspace.tmux_session,
        window_name: renamedWorkspace.tmux_window,
        new_window_name: workspace.tmux_window,
      });
    } catch (error: unknown) {
      failures.push(
        `failed to restore tmux window ${workspace.tmux_session}:${workspace.tmux_window}: ${formatError(error)}`,
      );
    }
  }

  return failures;
}

export async function renameWorkspace(
  params: RenameWorkspaceInput,
  _config: PitchConfig,
  dependencyOverrides: Partial<RenameWorkspaceDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateInput(params);
  const dependencies: RenameWorkspaceDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const workspace = await readWorkspaceOrThrow(input.name, dependencies);

  if (input.name === input.new_name) {
    return workspace;
  }

  let targetWorkspace: WorkspaceRecord | null;
  try {
    targetWorkspace = await dependencies.readWorkspaceRecord(input.new_name);
  } catch (error: unknown) {
    throw new RenameWorkspaceError(
      `Failed to inspect target workspace "${input.new_name}": ${formatError(error)}`,
    );
  }
  if (targetWorkspace !== null) {
    throw new RenameWorkspaceError(
      `Target workspace already exists: ${input.new_name}`,
    );
  }

  if (workspace.status === "active" && workspace.environment_kind === "vm-ssh") {
    throw new RenameWorkspaceError(
      `Cannot rename active vm-ssh workspace ${workspace.name}; close it first`,
    );
  }

  const renamedAgentEnv = { ...workspace.agent_env };
  if (Object.hasOwn(renamedAgentEnv, "PITCH_WORKSPACE_NAME")) {
    renamedAgentEnv.PITCH_WORKSPACE_NAME = input.new_name;
  }
  const renamedWorkspace: WorkspaceRecord = {
    ...workspace,
    name: input.new_name,
    worktree_name: getWorkspaceWorktreeName(workspace),
    tmux_window: input.new_name,
    agent_env: renamedAgentEnv,
    updated_at: dependencies.now().toISOString(),
  };

  let windowRenamed = false;
  if (workspace.status === "active") {
    let sourceExists: boolean;
    let targetExists: boolean;
    try {
      [sourceExists, targetExists] = await Promise.all([
        dependencies.tmuxWindowExists(
          workspace.tmux_session,
          workspace.tmux_window,
        ),
        dependencies.tmuxWindowExists(
          workspace.tmux_session,
          input.new_name,
        ),
      ]);
    } catch (error: unknown) {
      throw new RenameWorkspaceError(
        `Failed to inspect tmux windows for ${workspace.name}: ${formatError(error)}`,
      );
    }

    if (!sourceExists) {
      throw new RenameWorkspaceError(
        `Source tmux window not found: ${workspace.tmux_session}:${workspace.tmux_window}`,
      );
    }
    if (targetExists) {
      throw new RenameWorkspaceError(
        `Target tmux window already exists: ${workspace.tmux_session}:${input.new_name}`,
      );
    }

    try {
      await dependencies.renameTmuxWindow({
        session_name: workspace.tmux_session,
        window_name: workspace.tmux_window,
        new_window_name: input.new_name,
      });
      windowRenamed = true;
    } catch (error: unknown) {
      throw new RenameWorkspaceError(
        `Failed to rename tmux window ${workspace.tmux_session}:${workspace.tmux_window}: ${formatError(error)}`,
      );
    }
  }

  try {
    await dependencies.writeWorkspaceRecord(renamedWorkspace);
    const deleted = await dependencies.deleteWorkspaceRecord(workspace.name);
    if (!deleted) {
      throw new Error(`source workspace state disappeared: ${workspace.name}`);
    }
    return renamedWorkspace;
  } catch (error: unknown) {
    const rollbackFailures = await rollbackRename(
      workspace,
      renamedWorkspace,
      windowRenamed,
      dependencies,
    );
    const rollbackMessage =
      rollbackFailures.length === 0
        ? ""
        : `\nRollback errors:\n${rollbackFailures.map((failure) => `  - ${failure}`).join("\n")}`;
    throw new RenameWorkspaceError(
      `Failed to persist workspace rename ${workspace.name} -> ${input.new_name}: ${formatError(error)}${rollbackMessage}`,
    );
  }
}

export function registerRenameWorkspaceTool(
  server: McpServer,
  config: PitchConfig,
  dependencies: Partial<RenameWorkspaceDependencies> = {},
): void {
  server.registerTool(
    "rename_workspace",
    {
      description:
        "Rename a tracked workspace and its tmux window without changing its branch or worktree path.",
      inputSchema: RenameWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args) => {
      const workspace = await renameWorkspace(args, config, dependencies);
      return buildWorkspaceToolResponse(workspace);
    },
  );
}
