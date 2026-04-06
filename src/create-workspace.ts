import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join, posix } from "node:path";
import { z } from "zod";
import {
  buildAgentStartCommand,
  resolveAgentEnv,
  type BuiltAgentCommand,
} from "./agent-launcher.js";
import { buildBootstrapPrompt } from "./bootstrap-prompt.js";
import { ensureClaudeTrustedPaths } from "./claude-trust.js";
import type { PitchConfig, RepoConfig } from "./config.js";
import { ensureCodexTrustedPath } from "./codex-trust.js";
import {
  ensureWorkspaceWorktree,
  fetchGitRef,
  findManagedWorktreeForBranch,
  removeWorktree,
} from "./git.js";
import { runGitHubLifecycle } from "./github-lifecycle.js";
import { readPullRequest } from "./github-pr.js";
import {
  isVmAgentActiveOnHost,
  mapAdditionalPathsForEnvironment,
  mapPathForEnvironment,
  resolveExecutionEnvironment,
  resolveWorkspacePaths,
  type ResolvedExecutionEnvironment,
  type ResolvedWorkspacePaths,
} from "./execution-environment.js";
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
  type TmuxPaneLayout,
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
import { buildWorkspaceToolResponse } from "./workspace-tool-response.js";
import { formatAgentPaneCommand } from "./agent-pane-command.js";
import { ensureOpencodeConfig } from "./opencode-config.js";
import { sendConfiguredPaneCommands } from "./pane-commands.js";
import { shellEscape } from "./shell.js";

export const CreateWorkspaceInputSchema = z
  .object({
    repo: z.string().trim().min(1).optional(),
    issue: z.number().int().positive().optional(),
    pr: z.number().int().positive().optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "Name must use lowercase letters, numbers, and hyphens",
      )
      .optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "Slug must use lowercase letters, numbers, and hyphens",
      )
      .optional(),
    branch: z.string().trim().min(1).optional(),
    base_branch: z.string().trim().min(1).optional(),
    agent: z.string().trim().min(1).optional(),
    environment: z.string().trim().min(1).optional(),
    skip_prompt: z.boolean().optional(),
    model: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const sourceSelectors = [
      input.issue !== undefined,
      input.pr !== undefined,
      input.name !== undefined,
    ].filter(Boolean).length;

    if (sourceSelectors !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issue"],
        message: "Provide exactly one of issue, pr, or name",
      });
    }

    if (input.pr !== undefined && input.base_branch !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_branch"],
        message: "base_branch is only supported for issue and ad hoc workspaces",
      });
    }

    if (input.branch !== undefined && input.name === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["name"],
        message: "branch is only supported when name is provided",
      });
    }

    if (
      input.branch !== undefined &&
      (input.issue !== undefined || input.pr !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branch"],
        message: "branch is only supported for ad hoc workspaces",
      });
    }

    if (
      input.slug !== undefined &&
      input.name !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: "slug cannot be used with ad hoc workspaces",
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
  findManagedWorktreeForBranch: typeof findManagedWorktreeForBranch;
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
  ensureClaudeTrustedPaths: typeof ensureClaudeTrustedPaths;
  ensureCodexTrustedPath: typeof ensureCodexTrustedPath;
}

export class CreateWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateWorkspaceError";
  }
}

interface RollbackState {
  workspace_name: string;
  worktree_name: string;
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
      kind: "connected-shell";
      pane_id: string;
    }
  | {
      kind: "agent";
      pane_id: string;
    };

interface ResolvedWorkspaceSource {
  source_kind: WorkspaceRecord["source_kind"];
  source_number: number | null;
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
  findManagedWorktreeForBranch,
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
  ensureClaudeTrustedPaths,
  ensureCodexTrustedPath,
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

function appendSlug(baseName: string, slug?: string): string {
  return slug === undefined ? baseName : `${baseName}-${slug}`;
}

function buildIssueWorkspaceName(issue: number, slug?: string): string {
  return appendSlug(`gh-${issue}`, slug);
}

function buildPullRequestWorkspaceName(pr: number, slug?: string): string {
  return appendSlug(`pr-${pr}`, slug);
}

function buildPullRequestWorktreeName(pr: number): string {
  return `pr-${pr}`;
}

function buildRequestedWorkspaceName(input: CreateWorkspaceInput): string {
  if (input.issue !== undefined) {
    return buildIssueWorkspaceName(input.issue, input.slug);
  }

  if (input.pr !== undefined) {
    return buildPullRequestWorkspaceName(input.pr, input.slug);
  }

  if (input.name !== undefined) {
    return input.name;
  }

  throw new CreateWorkspaceError("Provide exactly one of issue, pr, or name");
}

function matchesReusablePullRequestCheckout(
  workspace: WorkspaceRecord,
  repoName: string,
  workspaceName: string,
  branch: string,
): boolean {
  return (
    workspace.repo === repoName &&
    workspace.name !== workspaceName &&
    workspace.branch === branch
  );
}

async function resolveWorktreeName(
  source: ResolvedWorkspaceSource,
  repoName: string,
  repoConfig: RepoConfig,
  dependencies: CreateWorkspaceDependencies,
): Promise<{
  worktree_name: string;
  reused_workspace?: WorkspaceRecord;
  reused_worktree_name?: string;
}> {
  if (source.source_kind !== "pr") {
    return {
      worktree_name: source.workspace_name,
    };
  }

  const existingWorkspaces = await dependencies.listWorkspaceRecords({
    repo: repoName,
    status: "all",
  });
  const reusableWorkspace =
    existingWorkspaces.find(
      (workspace) =>
        workspace.status === "active" &&
        matchesReusablePullRequestCheckout(
          workspace,
          repoName,
          source.workspace_name,
          source.branch,
        ),
    ) ??
    existingWorkspaces.find((workspace) =>
      matchesReusablePullRequestCheckout(
        workspace,
        repoName,
        source.workspace_name,
        source.branch,
      ),
    );

  if (reusableWorkspace !== undefined) {
    return {
      worktree_name: getWorkspaceWorktreeName(reusableWorkspace),
      reused_workspace: reusableWorkspace,
    };
  }

  const reusableManagedWorktree = await dependencies.findManagedWorktreeForBranch(
    repoConfig,
    source.branch,
  );

  if (reusableManagedWorktree !== null) {
    return {
      worktree_name: reusableManagedWorktree.workspace_name,
      reused_worktree_name: reusableManagedWorktree.workspace_name,
    };
  }

  if (source.source_number === null) {
    throw new CreateWorkspaceError(
      `PR workspace ${source.workspace_name} is missing its source number`,
    );
  }

  return {
    worktree_name: buildPullRequestWorktreeName(source.source_number),
  };
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

  if (input.name !== undefined) {
    const baseBranch = input.base_branch ?? config.defaults.base_branch;

    return {
      source_kind: "adhoc",
      source_number: null,
      workspace_name: input.name,
      branch: input.branch ?? input.name,
      base_branch: baseBranch,
      start_point: baseBranch,
    };
  }

  if (input.pr === undefined) {
    throw new CreateWorkspaceError("Provide exactly one of issue, pr, or name");
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
      fallback_remote: `${new URL(pullRequest.url).origin}/${repoName}.git`,
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
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths,
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
    const additionalPaths = mapAdditionalPathsForEnvironment(
      repoConfig.additional_paths,
      environment,
      workspacePaths,
    );
    const rootDir =
      environment.kind === "vm-ssh"
        ? join(workspacePaths.host_worktree_path, ".pitch", "opencode")
        : undefined;
    return await dependencies.ensureOpencodeConfig({
      workspace_name: workspaceName,
      additional_paths: additionalPaths,
      base_config_path: resolveAgentEnv(config, agentName, repoName).OPENCODE_CONFIG,
    }, rootDir);
  } catch (error: unknown) {
    throw new CreateWorkspaceError(
      `Failed to prepare OpenCode config for ${workspaceName}: ${formatError(error)}`,
    );
  }
}

function resolveAgentOpencodeConfigPath(
  environment: ResolvedExecutionEnvironment,
  workspaceName: string,
  workspacePaths: ResolvedWorkspacePaths,
  generatedConfigPath: string | undefined,
): string | undefined {
  if (generatedConfigPath === undefined) {
    return undefined;
  }

  if (environment.kind !== "vm-ssh") {
    return generatedConfigPath;
  }

  return posix.join(
    workspacePaths.guest_worktree_path,
    ".pitch",
    "opencode",
    `${workspaceName}.json`,
  );
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

async function classifyExistingPane(
  currentCommand: string,
  agentCommand: BuiltAgentCommand,
  workspaceName: string,
  worktreePath: string,
): Promise<ExistingPaneState["kind"] | "unsupported"> {
  if (SHELL_COMMANDS.has(currentCommand)) {
    return "shell";
  }

  if (currentCommand === agentCommand.pane_process_name) {
    if (agentCommand.environment_kind === "vm-ssh") {
      return (await isVmAgentActiveOnHost(worktreePath, workspaceName))
        ? "agent"
        : "connected-shell";
    }

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
        workspace_name: state.worktree_name,
      });
    } catch (error: unknown) {
      cleanupErrors.push(
        `Failed to remove worktree ${state.worktree_name}: ${formatError(error)}`,
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
    worktree_name: workspaceName,
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

    const source = await resolveWorkspaceSource(
      input,
      repoName,
      repoConfig,
      config,
      dependencies,
    );
    const worktreeTarget = await resolveWorktreeName(
      source,
      repoName,
      repoConfig,
      dependencies,
    );
    rollbackState.worktree_name = worktreeTarget.worktree_name;

    if (worktreeTarget.reused_workspace !== undefined) {
      reportWarnings(dependencies.reportWarning, [
        `PR head branch ${source.branch} is already tracked by workspace ${worktreeTarget.reused_workspace.name}; reusing worktree ${worktreeTarget.worktree_name}.`,
      ]);
    } else if (worktreeTarget.reused_worktree_name !== undefined) {
      reportWarnings(dependencies.reportWarning, [
        `PR head branch ${source.branch} is already checked out in managed worktree ${worktreeTarget.reused_worktree_name}; adopting that worktree.`,
      ]);
    }

    const worktree = await dependencies.ensureWorkspaceWorktree({
      repo: repoConfig,
      workspace_name: worktreeTarget.worktree_name,
      branch: source.branch,
      start_point: source.start_point,
      ...(source.source_kind === "pr" ? { allow_branch_reuse: true } : {}),
    });
    rollbackState.worktree_created = !worktree.adopted;

    await dependencies.ensureTmuxSession({
      session_name: repoConfig.tmux_session,
      start_directory: worktree.worktree_path,
    });

    const environment = resolveExecutionEnvironment(
      config,
      repoName,
      input.environment,
    );
    const workspacePaths = resolveWorkspacePaths(
      environment,
      worktreeTarget.worktree_name,
      worktree.worktree_path,
    );

    const initialPrompt = input.skip_prompt === true
      ? undefined
      : buildBootstrapPrompt(config, {
          repo: repoName,
          source_kind: source.source_kind,
          source_number: source.source_number,
          workspace_name: workspaceName,
          branch: worktree.branch,
        });
    const generatedOpencodeConfigPath = await maybeEnsureOpencodeConfig(
      config,
      repoName,
      agentName,
      workspaceName,
      environment,
      workspacePaths,
      dependencies,
    );
    const opencodeConfigPath = resolveAgentOpencodeConfigPath(
      environment,
      workspaceName,
      workspacePaths,
      generatedOpencodeConfigPath,
    );

    const agentCommand = dependencies.buildAgentStartCommand({
      config,
      agent: agentName,
      repo: repoName,
      ...(repoConfig.sandbox === undefined ? {} : { sandbox: repoConfig.sandbox }),
      environment: environment.name,
      opencode_config_path: opencodeConfigPath,
      workspace_name: workspaceName,
      worktree_path: workspacePaths.agent_worktree_path,
      host_worktree_path: workspacePaths.host_worktree_path,
      initial_prompt: initialPrompt,
      override_args: buildAgentOverrides(input),
    });

    if (agentCommand.agent_type === "claude") {
      try {
        await dependencies.ensureClaudeTrustedPaths({
          environment,
          workspace_paths: workspacePaths,
          repo: repoConfig,
          claude_config_dir: agentCommand.agent_env.CLAUDE_CONFIG_DIR,
        });
      } catch (error: unknown) {
        reportWarnings(dependencies.reportWarning, [
          `Failed to pre-trust Claude workspace paths for ${workspaceName}: ${formatError(error)}`,
        ]);
      }
    }

    if (agentCommand.agent_type === "codex") {
      try {
        await dependencies.ensureCodexTrustedPath({
          environment,
          workspace_paths: workspacePaths,
          codex_home: agentCommand.agent_env.CODEX_HOME,
        });
      } catch (error: unknown) {
        reportWarnings(dependencies.reportWarning, [
          `Failed to pre-trust Codex workspace path for ${workspaceName}: ${formatError(error)}`,
        ]);
      }
    }

    reportWarnings(dependencies.reportWarning, agentCommand.warnings);

    let existingPane: ExistingPaneState | null = null;
    let agentPaneId: string;
    let createdPanes: TmuxPaneLayout | null = null;
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
      const paneKind = await classifyExistingPane(
        paneInfo.current_command,
        agentCommand,
        workspaceName,
        worktree.worktree_path,
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
      createdPanes = layout.panes;
      agentPaneId = layout.panes.agent_pane_id;
    }

    const timestamp = dependencies.now().toISOString();
    const workspaceRecord: WorkspaceRecord = {
      name: workspaceName,
      worktree_name: worktreeTarget.worktree_name,
      repo: repoName,
      source_kind: source.source_kind,
      source_number: source.source_number,
      branch: worktree.branch,
      worktree_path: worktree.worktree_path,
      guest_worktree_path: workspacePaths.guest_worktree_path,
      base_branch: source.base_branch,
      tmux_session: repoConfig.tmux_session,
      tmux_window: workspaceName,
      agent_name: agentCommand.agent_name,
      agent_type: agentCommand.agent_type,
      ...(repoConfig.sandbox === undefined ? {} : { sandbox_name: repoConfig.sandbox }),
      environment_name: environment.name ?? null,
      environment_kind: environment.kind,
      agent_pane_process: agentCommand.pane_process_name,
      agent_env: agentCommand.agent_env,
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
        command: formatAgentPaneCommand(
          agentCommand,
          existingPane?.kind === "connected-shell",
        ),
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

    if (createdPanes !== null) {
      await sendConfiguredPaneCommands(
        workspaceName,
        repoConfig.pane_commands,
        createdPanes,
        {
          sendKeysToPane: dependencies.sendKeysToPane,
          reportWarning: dependencies.reportWarning,
        },
      );
    }

    try {
      if (source.source_kind !== "adhoc" && source.source_number !== null) {
        reportWarnings(
          dependencies.reportWarning,
          await dependencies.runGitHubLifecycle({
            repo: repoName,
            source_kind: source.source_kind,
            source_number: source.source_number,
          }),
        );
      }
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
