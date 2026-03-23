import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildAgentStartCommand,
  type BuiltAgentCommand,
} from "./agent-launcher.js";
import type { PitchConfig, RepoConfig } from "./config.js";
import {
  createWorktree,
  removeWorktree,
} from "./git.js";
import {
  createTmuxLayout,
  createTmuxWindow,
  ensureTmuxSession,
  killTmuxWindow,
  sendKeysToPane,
} from "./tmux.js";
import {
  deleteWorkspaceRecord,
  readWorkspaceRecord,
  WorkspaceRecordSchema,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from "./workspace-state.js";
import { formatAgentPaneCommand } from "./agent-pane-command.js";

export const CreateWorkspaceInputSchema = z
  .object({
    repo: z.string().trim().min(1).optional(),
    issue: z.number().int().positive(),
    slug: z
      .string()
      .trim()
      .min(1)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "Slug must use lowercase letters, numbers, and hyphens",
      ),
    base_branch: z.string().trim().min(1).optional(),
    agent: z.string().trim().min(1).optional(),
    runtime: z.enum(["native", "docker"]).optional(),
    model: z.string().trim().min(1).optional(),
  })
  .strict();

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

export interface CreateWorkspaceDependencies {
  readWorkspaceRecord: typeof readWorkspaceRecord;
  writeWorkspaceRecord: typeof writeWorkspaceRecord;
  deleteWorkspaceRecord: typeof deleteWorkspaceRecord;
  createWorktree: typeof createWorktree;
  removeWorktree: typeof removeWorktree;
  ensureTmuxSession: typeof ensureTmuxSession;
  createTmuxWindow: typeof createTmuxWindow;
  killTmuxWindow: typeof killTmuxWindow;
  createTmuxLayout: typeof createTmuxLayout;
  sendKeysToPane: typeof sendKeysToPane;
  buildAgentStartCommand: typeof buildAgentStartCommand;
  now: () => Date;
}

export class CreateWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateWorkspaceError";
  }
}

interface RollbackState {
  workspace_name: string;
  repo_config: RepoConfig;
  worktree_created: boolean;
  tmux_window_created: boolean;
  workspace_record_written: boolean;
}

const defaultDependencies: CreateWorkspaceDependencies = {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  deleteWorkspaceRecord,
  createWorktree,
  removeWorktree,
  ensureTmuxSession,
  createTmuxWindow,
  killTmuxWindow,
  createTmuxLayout,
  sendKeysToPane,
  buildAgentStartCommand,
  now: () => new Date(),
};

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

function validateInput(params: CreateWorkspaceInput): CreateWorkspaceInput {
  const result = CreateWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new CreateWorkspaceError(
      `Invalid create_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function resolveRepoName(config: PitchConfig, repo?: string): string {
  const resolved = repo ?? config.defaults.repo;
  if (resolved === undefined) {
    throw new CreateWorkspaceError(
      "No repo was provided and config.defaults.repo is not set",
    );
  }

  return resolved;
}

function resolveRepoConfig(config: PitchConfig, repoName: string): RepoConfig {
  const repoConfig = config.repos[repoName];
  if (repoConfig === undefined) {
    throw new CreateWorkspaceError(`Repo is not configured: ${repoName}`);
  }

  return repoConfig;
}

function resolveAgentName(config: PitchConfig, agent?: string): string {
  const resolved = agent ?? config.defaults.agent;
  if (resolved === undefined) {
    throw new CreateWorkspaceError(
      "No agent was provided and config.defaults.agent is not set",
    );
  }

  return resolved;
}

function buildWorkspaceName(issue: number, slug: string): string {
  return `gh-${issue}-${slug}`;
}

function buildAgentOverrides(
  input: CreateWorkspaceInput,
): string[] | undefined {
  if (input.model === undefined) {
    return undefined;
  }

  return ["--model", input.model];
}

function buildAgentSessions(
  command: BuiltAgentCommand,
  startedAt: string,
): WorkspaceRecord["agent_sessions"] {
  if (command.agent_type === "claude") {
    if (command.session_id === undefined) {
      throw new CreateWorkspaceError(
        "Claude start command did not include a pre-generated session id",
      );
    }

    return [
      {
        id: command.session_id,
        started_at: startedAt,
        status: "active",
      },
    ];
  }

  return [
    {
      id: "pending",
      started_at: startedAt,
      status: "pending",
    },
  ];
}

async function rollbackCreateWorkspace(
  state: RollbackState,
  dependencies: CreateWorkspaceDependencies,
): Promise<string[]> {
  const cleanupErrors: string[] = [];

  if (state.workspace_record_written) {
    try {
      await dependencies.deleteWorkspaceRecord(state.workspace_name);
    } catch (error: unknown) {
      cleanupErrors.push(
        `Failed to delete workspace state for ${state.workspace_name}: ${formatError(error)}`,
      );
    }
  }

  if (state.tmux_window_created) {
    try {
      await dependencies.killTmuxWindow({
        session_name: state.repo_config.tmux_session,
        window_name: state.workspace_name,
      });
    } catch (error: unknown) {
      cleanupErrors.push(
        `Failed to kill tmux window ${state.repo_config.tmux_session}:${state.workspace_name}: ${formatError(error)}`,
      );
    }
  }

  if (state.worktree_created) {
    try {
      await dependencies.removeWorktree({
        repo: state.repo_config,
        workspace_name: state.workspace_name,
      });
    } catch (error: unknown) {
      cleanupErrors.push(
        `Failed to remove worktree ${state.workspace_name}: ${formatError(error)}`,
      );
    }
  }

  return cleanupErrors;
}

export async function createWorkspace(
  params: CreateWorkspaceInput,
  config: PitchConfig,
  dependencyOverrides: Partial<CreateWorkspaceDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateInput(params);
  const dependencies: CreateWorkspaceDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const repoName = resolveRepoName(config, input.repo);
  const repoConfig = resolveRepoConfig(config, repoName);
  const agentName = resolveAgentName(config, input.agent);
  const baseBranch = input.base_branch ?? config.defaults.base_branch;
  const workspaceName = buildWorkspaceName(input.issue, input.slug);

  const rollbackState: RollbackState = {
    workspace_name: workspaceName,
    repo_config: repoConfig,
    worktree_created: false,
    tmux_window_created: false,
    workspace_record_written: false,
  };

  try {
    const existingWorkspace = await dependencies.readWorkspaceRecord(workspaceName);
    if (existingWorkspace !== null) {
      throw new CreateWorkspaceError(`Workspace already exists: ${workspaceName}`);
    }

    const worktree = await dependencies.createWorktree({
      repo: repoConfig,
      workspace_name: workspaceName,
      base_branch: baseBranch,
    });
    rollbackState.worktree_created = true;

    await dependencies.ensureTmuxSession({
      session_name: repoConfig.tmux_session,
      start_directory: worktree.worktree_path,
    });

    await dependencies.createTmuxWindow({
      session_name: repoConfig.tmux_session,
      window_name: workspaceName,
      start_directory: worktree.worktree_path,
    });
    rollbackState.tmux_window_created = true;

    const layout = await dependencies.createTmuxLayout({
      session_name: repoConfig.tmux_session,
      window_name: workspaceName,
      worktree_path: worktree.worktree_path,
    });

    const agentCommand = dependencies.buildAgentStartCommand({
      config,
      agent: agentName,
      repo: repoName,
      workspace_name: workspaceName,
      worktree_path: worktree.worktree_path,
      override_args: buildAgentOverrides(input),
      runtime: input.runtime,
    });

    const timestamp = dependencies.now().toISOString();
    const workspaceRecord: WorkspaceRecord = {
      name: workspaceName,
      repo: repoName,
      issue: input.issue,
      branch: worktree.branch,
      worktree_path: worktree.worktree_path,
      base_branch: baseBranch,
      tmux_session: repoConfig.tmux_session,
      tmux_window: workspaceName,
      agent_type: agentCommand.agent_type,
      agent_profile: agentCommand.profile_name ?? null,
      agent_runtime: agentCommand.runtime,
      agent_env: agentCommand.env,
      agent_sessions: buildAgentSessions(agentCommand, timestamp),
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
    };

    const persistedRecord = await dependencies.writeWorkspaceRecord(workspaceRecord);
    rollbackState.workspace_record_written = true;

    await dependencies.sendKeysToPane({
      pane_id: layout.panes.agent_pane_id,
      command: formatAgentPaneCommand(agentCommand),
    });

    return persistedRecord;
  } catch (error: unknown) {
    const cleanupErrors = await rollbackCreateWorkspace(
      rollbackState,
      dependencies,
    );
    let message = `Failed to create workspace ${workspaceName}: ${formatError(error)}`;

    if (cleanupErrors.length > 0) {
      message = `${message}\nRollback cleanup also failed:\n${cleanupErrors
        .map((cleanupError) => `  - ${cleanupError}`)
        .join("\n")}`;
    }

    throw new CreateWorkspaceError(message);
  }
}

export function registerCreateWorkspaceTool(
  server: McpServer,
  config: PitchConfig,
  dependencies: Partial<CreateWorkspaceDependencies> = {},
): void {
  server.registerTool(
    "create_workspace",
    {
      description:
        "Create a new workspace: worktree, tmux layout, agent launch, and state record.",
      inputSchema: CreateWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args) => {
      const workspace = await createWorkspace(args, config, dependencies);
      return {
        content: [{ type: "text", text: JSON.stringify(workspace) }],
        structuredContent: workspace,
      };
    },
  );
}
