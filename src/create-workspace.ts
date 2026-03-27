import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildAgentStartCommand,
  resolveAgentEnv,
  type BuiltAgentCommand,
} from "./agent-launcher.js";
import { buildBootstrapPrompt } from "./bootstrap-prompt.js";
import type { PitchConfig, RepoConfig } from "./config.js";
import {
  ensureWorkspaceWorktree,
  fetchGitRef,
  removeWorktree,
} from "./git.js";
import { runGitHubLifecycle } from "./github-lifecycle.js";
import { readPullRequest } from "./github-pr.js";
import { sendPostLaunchPromptToPane } from "./post-launch-prompt.js";
import {
  createTmuxLayout,
  createTmuxWindow,
  ensureTmuxSession,
  getTmuxPaneInfo,
  getTmuxWindowPaneInfo,
  killTmuxWindow,
  sendKeysToPane,
  tmuxWindowExists,
} from "./tmux.js";
import {
  deleteWorkspaceRecord,
  listWorkspaceRecords,
  readWorkspaceRecord,
  WorkspaceRecordSchema,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from "./workspace-state.js";
import { buildWorkspaceToolResponse } from "./workspace-tool-response.js";
import { formatAgentPaneCommand } from "./agent-pane-command.js";
import { ensureOpencodeConfig } from "./opencode-config.js";
import { shellEscape } from "./shell.js";

export const CreateWorkspaceInputSchema = z
  .object({
    repo: z.string().trim().min(1).optional(),
    issue: z.number().int().positive().optional(),
    pr: z.number().int().positive().optional(),
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
  .strict()
  .superRefine((input, ctx) => {
    if ((input.issue === undefined) === (input.pr === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issue"],
        message: "Provide exactly one of issue or pr",
      });
    }

    if (input.pr !== undefined && input.base_branch !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_branch"],
        message: "base_branch is only supported for issue workspaces",
      });
    }
  });

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

export interface CreateWorkspaceDependencies {
  readWorkspaceRecord: typeof readWorkspaceRecord;
  listWorkspaceRecords: typeof listWorkspaceRecords;
  writeWorkspaceRecord: typeof writeWorkspaceRecord;
  deleteWorkspaceRecord: typeof deleteWorkspaceRecord;
  ensureWorkspaceWorktree: typeof ensureWorkspaceWorktree;
  fetchGitRef: typeof fetchGitRef;
  removeWorktree: typeof removeWorktree;
  readPullRequest: typeof readPullRequest;
  ensureTmuxSession: typeof ensureTmuxSession;
  tmuxWindowExists: typeof tmuxWindowExists;
  createTmuxWindow: typeof createTmuxWindow;
  getTmuxWindowPaneInfo: typeof getTmuxWindowPaneInfo;
  killTmuxWindow: typeof killTmuxWindow;
  createTmuxLayout: typeof createTmuxLayout;
  sendKeysToPane: typeof sendKeysToPane;
  getTmuxPaneInfo: typeof getTmuxPaneInfo;
  buildAgentStartCommand: typeof buildAgentStartCommand;
  runGitHubLifecycle: typeof runGitHubLifecycle;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  reportWarning?: (warning: string) => void;
  ensureOpencodeConfig: typeof ensureOpencodeConfig;
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

type ExistingPaneState =
  | {
      kind: "shell";
      pane_id: string;
    }
  | {
      kind: "agent";
      pane_id: string;
    };

interface ResolvedWorkspaceSource {
  source_kind: WorkspaceRecord["source_kind"];
  source_number: number;
  workspace_name: string;
  branch: string;
  base_branch: string;
  start_point: string;
}

const defaultDependencies: CreateWorkspaceDependencies = {
  readWorkspaceRecord,
  listWorkspaceRecords,
  writeWorkspaceRecord,
  deleteWorkspaceRecord,
  ensureWorkspaceWorktree,
  fetchGitRef,
  removeWorktree,
  readPullRequest,
  ensureTmuxSession,
  tmuxWindowExists,
  createTmuxWindow,
  getTmuxWindowPaneInfo,
  killTmuxWindow,
  createTmuxLayout,
  sendKeysToPane,
  getTmuxPaneInfo,
  buildAgentStartCommand,
  runGitHubLifecycle,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  ensureOpencodeConfig,
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

function resolveAgentName(
  config: PitchConfig,
  repoConfig: RepoConfig,
  agent?: string,
): string {
  const resolved = agent ?? repoConfig.default_agent ?? config.defaults.agent;
  if (resolved === undefined) {
    throw new CreateWorkspaceError(
      "No agent was provided and neither repo default_agent nor config.defaults.agent is set",
    );
  }

  return resolved;
}

function buildIssueWorkspaceName(issue: number, slug: string): string {
  return `gh-${issue}-${slug}`;
}

function buildPullRequestWorkspaceName(pr: number, slug: string): string {
  return `pr-${pr}-${slug}`;
}

function buildRequestedWorkspaceName(input: CreateWorkspaceInput): string {
  if (input.issue !== undefined) {
    return buildIssueWorkspaceName(input.issue, input.slug);
  }

  if (input.pr !== undefined) {
    return buildPullRequestWorkspaceName(input.pr, input.slug);
  }

  throw new CreateWorkspaceError("Provide exactly one of issue or pr");
}

async function ensureNoTrackedPullRequestWorkspace(
  input: CreateWorkspaceInput,
  repoName: string,
  workspaceName: string,
  dependencies: CreateWorkspaceDependencies,
): Promise<void> {
  if (input.pr === undefined) {
    return;
  }

  const existingWorkspaces = await dependencies.listWorkspaceRecords({
    repo: repoName,
    status: "all",
  });
  const existingPullRequestWorkspace = existingWorkspaces.find(
    (workspace) =>
      workspace.source_kind === "pr" &&
      workspace.source_number === input.pr &&
      workspace.name !== workspaceName,
  );

  if (existingPullRequestWorkspace !== undefined) {
    throw new CreateWorkspaceError(
      `PR #${input.pr} already has a tracked workspace: ${existingPullRequestWorkspace.name}`,
    );
  }
}

async function resolveWorkspaceSource(
  input: CreateWorkspaceInput,
  repoName: string,
  repoConfig: RepoConfig,
  config: PitchConfig,
  dependencies: CreateWorkspaceDependencies,
): Promise<ResolvedWorkspaceSource> {
  if (input.issue !== undefined) {
    const baseBranch = input.base_branch ?? config.defaults.base_branch;
    const workspaceName = buildIssueWorkspaceName(input.issue, input.slug);

    return {
      source_kind: "issue",
      source_number: input.issue,
      workspace_name: workspaceName,
      branch: workspaceName,
      base_branch: baseBranch,
      start_point: baseBranch,
    };
  }

  if (input.pr === undefined) {
    throw new CreateWorkspaceError("Provide exactly one of issue or pr");
  }

  let pullRequest;
  try {
    pullRequest = await dependencies.readPullRequest({
      repo: repoName,
      pr_number: input.pr,
    });
  } catch (error: unknown) {
    throw new CreateWorkspaceError(
      `Failed to resolve PR #${input.pr}: ${formatError(error)}`,
    );
  }

  if (pullRequest.state !== "OPEN") {
    throw new CreateWorkspaceError(
      `PR #${pullRequest.number} is not open: ${pullRequest.state}`,
    );
  }

  const workspaceName = buildPullRequestWorkspaceName(
    pullRequest.number,
    input.slug,
  );
  const startPoint = `refs/pitch/pr/${pullRequest.number}/head`;

  try {
    await dependencies.fetchGitRef({
      repo: repoConfig,
      remote: "origin",
      source_ref: `refs/pull/${pullRequest.number}/head`,
      destination_ref: startPoint,
    });
  } catch (error: unknown) {
    throw new CreateWorkspaceError(
      `Failed to fetch PR #${pullRequest.number} head ref: ${formatError(error)}`,
    );
  }

  return {
    source_kind: "pr",
    source_number: pullRequest.number,
    workspace_name: workspaceName,
    branch: pullRequest.head_ref_name,
    base_branch: pullRequest.base_ref_name,
    start_point: startPoint,
  };
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

async function maybeEnsureOpencodeConfig(
  config: PitchConfig,
  repoName: string,
  agentName: string,
  workspaceName: string,
  dependencies: CreateWorkspaceDependencies,
): Promise<string | undefined> {
  const agentConfig = config.agents[agentName];
  if (agentConfig === undefined || agentConfig.type !== "opencode") {
    return undefined;
  }

  const repoConfig = config.repos[repoName];
  if (repoConfig === undefined) {
    throw new CreateWorkspaceError(`Repo is not configured: ${repoName}`);
  }

  try {
    return await dependencies.ensureOpencodeConfig({
      workspace_name: workspaceName,
      additional_paths: repoConfig.additional_paths,
      base_config_path: resolveAgentEnv(config, agentName, repoName).OPENCODE_CONFIG,
    });
  } catch (error: unknown) {
    throw new CreateWorkspaceError(
      `Failed to prepare OpenCode config for ${workspaceName}: ${formatError(error)}`,
    );
  }
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

function classifyExistingPane(
  currentCommand: string,
  agentCommand: BuiltAgentCommand,
): ExistingPaneState["kind"] | "unsupported" {
  if (SHELL_COMMANDS.has(currentCommand)) {
    return "shell";
  }

  if (
    currentCommand === "claude" &&
    agentCommand.agent_type === "claude" &&
    agentCommand.runtime === "native"
  ) {
    return "agent";
  }

  if (
    currentCommand === "codex" &&
    agentCommand.agent_type === "codex" &&
    agentCommand.runtime === "native"
  ) {
    return "agent";
  }

  if (
    currentCommand === "opencode" &&
    agentCommand.agent_type === "opencode" &&
    agentCommand.runtime === "native"
  ) {
    return "agent";
  }

  return "unsupported";
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
  const agentName = resolveAgentName(config, repoConfig, input.agent);
  const workspaceName = buildRequestedWorkspaceName(input);

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

    await ensureNoTrackedPullRequestWorkspace(
      input,
      repoName,
      workspaceName,
      dependencies,
    );

    const source = await resolveWorkspaceSource(
      input,
      repoName,
      repoConfig,
      config,
      dependencies,
    );

    const worktree = await dependencies.ensureWorkspaceWorktree({
      repo: repoConfig,
      workspace_name: workspaceName,
      branch: source.branch,
      start_point: source.start_point,
    });
    rollbackState.worktree_created = !worktree.adopted;

    await dependencies.ensureTmuxSession({
      session_name: repoConfig.tmux_session,
      start_directory: worktree.worktree_path,
    });

    const initialPrompt = buildBootstrapPrompt(config, {
      repo: repoName,
      source_kind: source.source_kind,
      source_number: source.source_number,
      workspace_name: workspaceName,
      branch: worktree.branch,
    });
    const opencodeConfigPath = await maybeEnsureOpencodeConfig(
      config,
      repoName,
      agentName,
      workspaceName,
      dependencies,
    );

    const agentCommand = dependencies.buildAgentStartCommand({
      config,
      agent: agentName,
      repo: repoName,
      opencode_config_path: opencodeConfigPath,
      workspace_name: workspaceName,
      worktree_path: worktree.worktree_path,
      initial_prompt: initialPrompt,
      override_args: buildAgentOverrides(input),
      runtime: input.runtime,
    });
    reportWarnings(dependencies.reportWarning, agentCommand.warnings);

    let existingPane: ExistingPaneState | null = null;
    let agentPaneId: string;
    const windowExists = await dependencies.tmuxWindowExists(
      repoConfig.tmux_session,
      workspaceName,
    );

    if (windowExists) {
      const paneInfo = await dependencies.getTmuxWindowPaneInfo({
        session_name: repoConfig.tmux_session,
        window_name: workspaceName,
        pane_index: 0,
      });
      const paneKind = classifyExistingPane(
        paneInfo.current_command,
        agentCommand,
      );

      if (paneKind === "unsupported") {
        throw new CreateWorkspaceError(
          `Existing tmux window ${repoConfig.tmux_session}:${workspaceName} has unsupported pane 0 command: ${paneInfo.current_command}`,
        );
      }

      if (
        paneKind === "agent" &&
        paneInfo.current_path !== worktree.worktree_path
      ) {
        throw new CreateWorkspaceError(
          `Existing tmux window ${repoConfig.tmux_session}:${workspaceName} pane 0 is rooted at ${paneInfo.current_path}, expected ${worktree.worktree_path}`,
        );
      }

      existingPane = {
        kind: paneKind,
        pane_id: paneInfo.pane_id,
      };
      agentPaneId = paneInfo.pane_id;
    } else {
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
      agentPaneId = layout.panes.agent_pane_id;
    }

    const timestamp = dependencies.now().toISOString();
    const workspaceRecord: WorkspaceRecord = {
      name: workspaceName,
      repo: repoName,
      source_kind: source.source_kind,
      source_number: source.source_number,
      branch: worktree.branch,
      worktree_path: worktree.worktree_path,
      base_branch: source.base_branch,
      tmux_session: repoConfig.tmux_session,
      tmux_window: workspaceName,
      agent_name: agentCommand.agent_name,
      agent_type: agentCommand.agent_type,
      agent_runtime: agentCommand.runtime,
      agent_env: agentCommand.env,
      agent_sessions:
        existingPane?.kind === "agent"
          ? []
          : buildAgentSessions(agentCommand, timestamp),
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
    };

    const persistedRecord = await dependencies.writeWorkspaceRecord(workspaceRecord);
    rollbackState.workspace_record_written = true;

    if (existingPane?.kind !== "agent") {
      if (existingPane?.kind === "shell") {
        await dependencies.sendKeysToPane({
          pane_id: agentPaneId,
          command: `cd -- ${shellEscape(worktree.worktree_path)} && clear`,
        });
      }

      await dependencies.sendKeysToPane({
        pane_id: agentPaneId,
        command: formatAgentPaneCommand(agentCommand),
      });

      if (agentCommand.post_launch_prompt !== undefined) {
        try {
          await sendPostLaunchPromptToPane(
            agentPaneId,
            agentCommand.post_launch_prompt,
            agentCommand,
            workspaceName,
            dependencies,
          );
        } catch (error: unknown) {
          reportWarnings(dependencies.reportWarning, [
            `Failed to send bootstrap prompt to ${workspaceName}: ${formatError(error)}`,
          ]);
        }
      }
    }

    try {
      reportWarnings(
        dependencies.reportWarning,
        await dependencies.runGitHubLifecycle({
          repo: repoName,
          source_kind: source.source_kind,
          source_number: source.source_number,
        }),
      );
    } catch (error: unknown) {
      reportWarnings(dependencies.reportWarning, [
        `Failed to apply GitHub lifecycle automation for ${workspaceName}: ${formatError(error)}`,
      ]);
    }

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
        "Create a new workspace from a GitHub issue or pull request: worktree, tmux layout, agent launch, and state record.",
      inputSchema: CreateWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args: CreateWorkspaceInput) => {
      const warnings: string[] = [];
      const workspace = await createWorkspace(args, config, {
        ...dependencies,
        reportWarning: (warning) => warnings.push(warning),
      });
      return buildWorkspaceToolResponse(workspace, warnings);
    },
  );
}
