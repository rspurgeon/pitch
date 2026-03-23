import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listWorkspaceRecords,
  readWorkspaceRecord,
  WorkspaceRecordSchema,
  type ListWorkspacesOptions,
  type WorkspaceRecord,
} from "./workspace-state.js";

export const WorkspaceSummarySchema = z.object({
  name: z.string(),
  repo: z.string(),
  issue: z.number().int().positive(),
  status: z.enum(["active", "closed"]),
  agent_type: z.string(),
  tmux_session: z.string(),
  tmux_window: z.string(),
}).strict();

export const ListWorkspacesInputSchema = z.object({
  status: z.enum(["active", "closed", "all"]).optional(),
  repo: z.string().trim().min(1).optional(),
}).strict();

export const GetWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
}).strict();

export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type ListWorkspacesInput = z.infer<typeof ListWorkspacesInputSchema>;
export type GetWorkspaceInput = z.infer<typeof GetWorkspaceInputSchema>;

export interface WorkspaceQueryDependencies {
  listWorkspaceRecords: typeof listWorkspaceRecords;
  readWorkspaceRecord: typeof readWorkspaceRecord;
}

const defaultDependencies: WorkspaceQueryDependencies = {
  listWorkspaceRecords,
  readWorkspaceRecord,
};

export class WorkspaceQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceQueryError";
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

function validateListInput(
  params: ListWorkspacesInput,
): ListWorkspacesOptions {
  const result = ListWorkspacesInputSchema.safeParse(params);
  if (!result.success) {
    throw new WorkspaceQueryError(
      `Invalid list_workspaces input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function validateGetInput(params: GetWorkspaceInput): GetWorkspaceInput {
  const result = GetWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new WorkspaceQueryError(
      `Invalid get_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function toWorkspaceSummary(workspace: WorkspaceRecord): WorkspaceSummary {
  return {
    name: workspace.name,
    repo: workspace.repo,
    issue: workspace.issue,
    status: workspace.status,
    agent_type: workspace.agent_type,
    tmux_session: workspace.tmux_session,
    tmux_window: workspace.tmux_window,
  };
}

export async function listWorkspaces(
  params: ListWorkspacesInput = {},
  dependencyOverrides: Partial<WorkspaceQueryDependencies> = {},
): Promise<WorkspaceSummary[]> {
  const input = validateListInput(params);
  const dependencies: WorkspaceQueryDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const workspaces = await dependencies.listWorkspaceRecords(input);
  return workspaces.map(toWorkspaceSummary);
}

export async function getWorkspace(
  params: GetWorkspaceInput,
  dependencyOverrides: Partial<WorkspaceQueryDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateGetInput(params);
  const dependencies: WorkspaceQueryDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const workspace = await dependencies.readWorkspaceRecord(input.name);
  if (workspace === null) {
    throw new WorkspaceQueryError(`Workspace not found: ${input.name}`);
  }

  return workspace;
}

export function registerWorkspaceQueryTools(
  server: McpServer,
  dependencies: Partial<WorkspaceQueryDependencies> = {},
): void {
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List tracked workspaces, optionally filtered by status or repo.",
      inputSchema: ListWorkspacesInputSchema,
    },
    async (args) => {
      const workspaces = await listWorkspaces(args, dependencies);
      return {
        content: [{ type: "text", text: JSON.stringify(workspaces) }],
      };
    },
  );

  server.registerTool(
    "get_workspace",
    {
      description: "Get the full workspace record for a specific workspace.",
      inputSchema: GetWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args) => {
      const workspace = await getWorkspace(args, dependencies);
      return {
        content: [{ type: "text", text: JSON.stringify(workspace) }],
        structuredContent: workspace,
      };
    },
  );
}
