import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { access } from "node:fs/promises";
import { join, posix } from "node:path";
import { z } from "zod";
import {
  buildAgentResumeCommand,
  buildAgentStartCommand,
  resolveAgentEnv,
  type BuiltAgentCommand,
} from "./agent-launcher.js";
import { buildBootstrapPrompt } from "./bootstrap-prompt.js";
import { ensureClaudeTrustedPaths } from "./claude-trust.js";
import type { PitchConfig } from "./config.js";
import { ensureCodexTrustedPath } from "./codex-trust.js";
import { findCodexSessionForWorkspace } from "./codex-session-store.js";
import {
  buildVmAgentHostMarkerPath,
  deriveAgentPaneProcess,
  mapAdditionalPathsForEnvironment,
  resolveExecutionEnvironment,
  resolveWorkspacePaths,
  type ResolvedExecutionEnvironment,
  type ResolvedWorkspacePaths,
} from "./execution-environment.js";
import { runGitHubLifecycle } from "./github-lifecycle.js";
import { findOpencodeSessionForWorkspace } from "./opencode-session-store.js";
import { sendPostLaunchPromptToPane } from "./post-launch-prompt.js";
import { restoreWorktree } from "./git.js";
import {
  createTmuxLayout,
  createTmuxWindow,
  ensureTmuxSession,
  getTmuxPaneInfo,
  getTmuxWindowPaneInfo,
  getTmuxWindowPane,
  sendKeysToPane,
  tmuxWindowExists,
  type TmuxPaneInfo,
} from "./tmux.js";
import {
  readWorkspaceRecord,
  WorkspaceRecordSchema,
  writeWorkspaceRecord,
  type WorkspaceRecord,
} from "./workspace-state.js";
import { buildWorkspaceToolResponse } from "./workspace-tool-response.js";
import { formatAgentPaneCommand } from "./agent-pane-command.js";
import { ensureOpencodeConfig } from "./opencode-config.js";

export const ResumeWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
  environment: z.string().trim().min(1).optional(),
}).strict();

export type ResumeWorkspaceInput = z.infer<typeof ResumeWorkspaceInputSchema>;

export interface ResumeWorkspaceDependencies {
  buildAgentResumeCommand: typeof buildAgentResumeCommand;
  buildAgentStartCommand: typeof buildAgentStartCommand;
  createTmuxLayout: typeof createTmuxLayout;
  createTmuxWindow: typeof createTmuxWindow;
  ensureTmuxSession: typeof ensureTmuxSession;
  findCodexSessionForWorkspace: typeof findCodexSessionForWorkspace;
  findOpencodeSessionForWorkspace: typeof findOpencodeSessionForWorkspace;
  getTmuxWindowPaneInfo: typeof getTmuxWindowPaneInfo;
  getTmuxWindowPane: typeof getTmuxWindowPane;
  getTmuxPaneInfo: typeof getTmuxPaneInfo;
  readWorkspaceRecord: typeof readWorkspaceRecord;
  restoreWorktree: typeof restoreWorktree;
  runGitHubLifecycle: typeof runGitHubLifecycle;
  sendKeysToPane: typeof sendKeysToPane;
  sleep: (ms: number) => Promise<void>;
  tmuxWindowExists: typeof tmuxWindowExists;
  writeWorkspaceRecord: typeof writeWorkspaceRecord;
  now: () => Date;
  reportWarning?: (warning: string) => void;
  ensureOpencodeConfig: typeof ensureOpencodeConfig;
  ensureClaudeTrustedPaths: typeof ensureClaudeTrustedPaths;
  ensureCodexTrustedPath: typeof ensureCodexTrustedPath;
}

const defaultDependencies: ResumeWorkspaceDependencies = {
  buildAgentResumeCommand,
  buildAgentStartCommand,
  createTmuxLayout,
  createTmuxWindow,
  ensureTmuxSession,
  getTmuxPaneInfo,
  findCodexSessionForWorkspace,
  findOpencodeSessionForWorkspace,
  getTmuxWindowPaneInfo,
  getTmuxWindowPane,
  readWorkspaceRecord,
  restoreWorktree,
  runGitHubLifecycle,
  sendKeysToPane,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  tmuxWindowExists,
  writeWorkspaceRecord,
  now: () => new Date(),
  ensureOpencodeConfig,
  ensureClaudeTrustedPaths,
  ensureCodexTrustedPath,
};

export class ResumeWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeWorkspaceError";
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

function validateInput(params: ResumeWorkspaceInput): ResumeWorkspaceInput {
  const result = ResumeWorkspaceInputSchema.safeParse(params);
  if (!result.success) {
    throw new ResumeWorkspaceError(
      `Invalid resume_workspace input:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function resolveAgentName(
  workspace: WorkspaceRecord,
  overrideAgent?: string,
): string {
  if (overrideAgent !== undefined) {
    return overrideAgent;
  }

  return workspace.agent_name;
}

function currentWorkspaceAgentName(workspace: WorkspaceRecord): string {
  return workspace.agent_name;
}

function currentWorkspaceEnvironmentName(
  workspace: WorkspaceRecord,
): string | undefined {
  return workspace.environment_name ?? undefined;
}

function findLatestResumableSessionId(workspace: WorkspaceRecord): string | null {
  const sessions = [...workspace.agent_sessions].reverse();
  for (const session of sessions) {
    if (session.id !== "pending" && session.id.trim().length > 0) {
      return session.id;
    }
  }

  return null;
}

function findLatestPendingSessionIndex(workspace: WorkspaceRecord): number | null {
  for (let index = workspace.agent_sessions.length - 1; index >= 0; index -= 1) {
    const session = workspace.agent_sessions[index];
    if (session.id === "pending") {
      return index;
    }
  }

  return null;
}

function hasTrailingPendingSession(workspace: WorkspaceRecord): boolean {
  const pendingSessionIndex = findLatestPendingSessionIndex(workspace);
  return (
    pendingSessionIndex !== null &&
    pendingSessionIndex === workspace.agent_sessions.length - 1
  );
}

function backfillPendingSessionId(
  workspace: WorkspaceRecord,
  pendingIndex: number,
  sessionId: string,
): WorkspaceRecord {
  return {
    ...workspace,
    agent_sessions: workspace.agent_sessions.map((session, index) =>
      index === pendingIndex
        ? {
            ...session,
            id: sessionId,
            status: "active",
          }
        : session,
    ),
  };
}

function buildNextAgentSession(
  command: BuiltAgentCommand,
  startedAt: string,
): WorkspaceRecord["agent_sessions"][number] {
  if (command.agent_type === "claude") {
    if (command.session_id === undefined) {
      throw new ResumeWorkspaceError(
        "Claude resume command did not include a session id",
      );
    }

    return {
      id: command.session_id,
      started_at: startedAt,
      status: "active",
    };
  }

  if (command.session_id === undefined) {
    return {
      id: "pending",
      started_at: startedAt,
      status: "pending",
    };
  }

  return {
    id: command.session_id,
    started_at: startedAt,
    status: "active",
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isCompatibleRunningAgentPane(
  workspace: WorkspaceRecord,
  paneInfo: TmuxPaneInfo | null,
): Promise<boolean> {
  if (paneInfo === null || paneInfo.current_path !== workspace.worktree_path) {
    return false;
  }

  const expectedPaneProcess =
    workspace.agent_pane_process ??
    deriveAgentPaneProcess(
      workspace.agent_type,
      workspace.agent_runtime,
      workspace.environment_kind ?? "host",
    );

  if (paneInfo.current_command !== expectedPaneProcess) {
    return false;
  }

  if (workspace.environment_kind === "vm-ssh") {
    return pathExists(
      buildVmAgentHostMarkerPath(workspace.worktree_path),
    );
  }

  return true;
}

async function shouldReuseConnectedVmPane(
  workspace: WorkspaceRecord,
  paneInfo: TmuxPaneInfo | null,
  command: BuiltAgentCommand,
): Promise<boolean> {
  if (
    paneInfo === null ||
    workspace.environment_kind !== "vm-ssh" ||
    command.pane_reuse_command === undefined
  ) {
    return false;
  }

  if (paneInfo.current_command !== "ssh") {
    return false;
  }

  if (paneInfo.current_path !== workspace.worktree_path) {
    return false;
  }

  return !(await pathExists(buildVmAgentHostMarkerPath(workspace.worktree_path)));
}

async function maybeEnsureOpencodeConfig(
  config: PitchConfig,
  repoName: string,
  agentName: string,
  workspaceName: string,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths,
  dependencies: ResumeWorkspaceDependencies,
): Promise<string | undefined> {
  const agentConfig = config.agents[agentName];
  if (agentConfig === undefined || agentConfig.type !== "opencode") {
    return undefined;
  }

  const repoConfig = config.repos[repoName];
  if (repoConfig === undefined) {
    throw new ResumeWorkspaceError(`Repo is not configured: ${repoName}`);
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
    throw new ResumeWorkspaceError(
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

export async function resumeWorkspace(
  params: ResumeWorkspaceInput,
  config: PitchConfig,
  dependencyOverrides: Partial<ResumeWorkspaceDependencies> = {},
): Promise<WorkspaceRecord> {
  const input = validateInput(params);
  const dependencies: ResumeWorkspaceDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  let workspace: WorkspaceRecord | null;
  try {
    workspace = await dependencies.readWorkspaceRecord(input.name);
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to read workspace "${input.name}": ${formatError(error)}`,
    );
  }

  if (workspace === null) {
    throw new ResumeWorkspaceError(`Workspace not found: ${input.name}`);
  }

  if (workspace.status !== "active") {
    throw new ResumeWorkspaceError(
      `Workspace is not active: ${workspace.name}`,
    );
  }

  const repoConfig = config.repos[workspace.repo];
  if (repoConfig === undefined) {
    throw new ResumeWorkspaceError(`Repo is not configured: ${workspace.repo}`);
  }

  try {
    const restoredWorktree = await dependencies.restoreWorktree({
      repo: repoConfig,
      workspace_name: workspace.name,
      branch: workspace.branch,
    });
    workspace = {
      ...workspace,
      worktree_path: restoredWorktree.worktree_path,
    };
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to restore worktree for ${workspace.name}: ${formatError(error)}`,
    );
  }

  try {
    await dependencies.ensureTmuxSession({
      session_name: workspace.tmux_session,
      start_directory: workspace.worktree_path,
    });
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to ensure tmux session for ${workspace.name}: ${formatError(error)}`,
    );
  }

  let agentPaneId: string;
  let existingPaneInfo: TmuxPaneInfo | null = null;
  try {
    const windowExists = await dependencies.tmuxWindowExists(
      workspace.tmux_session,
      workspace.tmux_window,
    );

    if (!windowExists) {
      try {
        await dependencies.createTmuxWindow({
          session_name: workspace.tmux_session,
          window_name: workspace.tmux_window,
          start_directory: workspace.worktree_path,
        });
        const layout = await dependencies.createTmuxLayout({
          session_name: workspace.tmux_session,
          window_name: workspace.tmux_window,
          worktree_path: workspace.worktree_path,
        });
        agentPaneId = layout.panes.agent_pane_id;
      } catch (error: unknown) {
        throw new ResumeWorkspaceError(
          `Failed to restore tmux window for ${workspace.name}: ${formatError(error)}`,
        );
      }
    } else {
      existingPaneInfo = await dependencies.getTmuxWindowPaneInfo({
        session_name: workspace.tmux_session,
        window_name: workspace.tmux_window,
        pane_index: 0,
      });
      agentPaneId = await dependencies.getTmuxWindowPane({
        session_name: workspace.tmux_session,
        window_name: workspace.tmux_window,
        pane_index: 0,
      });
    }
  } catch (error: unknown) {
    if (error instanceof ResumeWorkspaceError) {
      throw error;
    }

    throw new ResumeWorkspaceError(
      `Failed to locate agent pane for ${workspace.name}: ${formatError(error)}`,
    );
  }

  const currentEnvironmentName = currentWorkspaceEnvironmentName(workspace);
  const environment: ResolvedExecutionEnvironment =
    input.environment !== undefined || currentEnvironmentName !== undefined
      ? resolveExecutionEnvironment(
          config,
          workspace.repo,
          input.environment ?? currentEnvironmentName,
        )
      : {
          kind: workspace.environment_kind ?? "host",
        };
  const derivedWorkspacePaths = resolveWorkspacePaths(
    environment,
    workspace.name,
    workspace.worktree_path,
  );
  const workspacePaths: ResolvedWorkspacePaths = {
    ...derivedWorkspacePaths,
    agent_worktree_path:
      workspace.guest_worktree_path ?? derivedWorkspacePaths.agent_worktree_path,
    guest_worktree_path:
      workspace.guest_worktree_path ?? derivedWorkspacePaths.guest_worktree_path,
  };

  const agentName = resolveAgentName(workspace, input.agent);
  const isAgentContextChanged =
    input.agent !== undefined && input.agent !== currentWorkspaceAgentName(workspace);
  const isEnvironmentContextChanged =
    input.environment !== undefined && input.environment !== currentEnvironmentName;
  const trailingPendingSession = hasTrailingPendingSession(workspace);

  let latestSessionId =
    isAgentContextChanged || isEnvironmentContextChanged || trailingPendingSession
      ? null
      : findLatestResumableSessionId(workspace);

  if (
    !isAgentContextChanged &&
    !isEnvironmentContextChanged &&
    trailingPendingSession &&
    latestSessionId === null &&
    workspace.agent_type === "codex" &&
    workspace.agent_runtime === "native" &&
    environment.kind === "host"
  ) {
    const pendingSessionIndex = findLatestPendingSessionIndex(workspace);

    if (pendingSessionIndex !== null) {
      const pendingSession = workspace.agent_sessions[pendingSessionIndex];
      let discoveredSession: Awaited<
        ReturnType<ResumeWorkspaceDependencies["findCodexSessionForWorkspace"]>
      > = null;
      try {
        discoveredSession = await dependencies.findCodexSessionForWorkspace({
          worktree_path: workspace.worktree_path,
          started_at: pendingSession.started_at,
          agent_env: workspace.agent_env,
        });
      } catch {
        discoveredSession = null;
      }

      if (discoveredSession !== null) {
        workspace = backfillPendingSessionId(
          workspace,
          pendingSessionIndex,
          discoveredSession.id,
        );
        latestSessionId = discoveredSession.id;
      }
    }
  }

  if (
    !isAgentContextChanged &&
    !isEnvironmentContextChanged &&
    trailingPendingSession &&
    latestSessionId === null &&
    workspace.agent_type === "opencode" &&
    workspace.agent_runtime === "native" &&
    environment.kind === "host"
  ) {
    const pendingSessionIndex = findLatestPendingSessionIndex(workspace);

    if (pendingSessionIndex !== null) {
      const pendingSession = workspace.agent_sessions[pendingSessionIndex];
      let discoveredSession: Awaited<
        ReturnType<ResumeWorkspaceDependencies["findOpencodeSessionForWorkspace"]>
      > = null;
      try {
        discoveredSession = await dependencies.findOpencodeSessionForWorkspace({
          worktree_path: workspace.worktree_path,
          started_at: pendingSession.started_at,
          agent_env: workspace.agent_env,
        });
      } catch {
        discoveredSession = null;
      }

      if (discoveredSession !== null) {
        workspace = backfillPendingSessionId(
          workspace,
          pendingSessionIndex,
          discoveredSession.id,
        );
        latestSessionId = discoveredSession.id;
      }
    }
  }

  if (
    !isAgentContextChanged &&
    !isEnvironmentContextChanged &&
    latestSessionId === null &&
    findLatestPendingSessionIndex(workspace) === null &&
    await isCompatibleRunningAgentPane(workspace, existingPaneInfo)
  ) {
    await dependencies.writeWorkspaceRecord(workspace);
    return workspace;
  }

  let command: BuiltAgentCommand;
  let isFreshLaunch = false;
  try {
    const generatedOpencodeConfigPath = await maybeEnsureOpencodeConfig(
      config,
      workspace.repo,
      agentName,
      workspace.name,
      environment,
      workspacePaths,
      dependencies,
    );
    const opencodeConfigPath = resolveAgentOpencodeConfigPath(
      environment,
      workspace.name,
      workspacePaths,
      generatedOpencodeConfigPath,
    );

    if (latestSessionId === null) {
      isFreshLaunch = true;
      command = dependencies.buildAgentStartCommand({
        config,
        agent: agentName,
        repo: workspace.repo,
        environment: environment.name,
        opencode_config_path: opencodeConfigPath,
        workspace_name: workspace.name,
        worktree_path: workspacePaths.agent_worktree_path,
        host_worktree_path: workspacePaths.host_worktree_path,
        initial_prompt: buildBootstrapPrompt(config, {
          repo: workspace.repo,
          source_kind: workspace.source_kind,
          source_number: workspace.source_number,
          workspace_name: workspace.name,
          branch: workspace.branch,
        }),
      });
    } else {
      command = dependencies.buildAgentResumeCommand({
        config,
        agent: agentName,
        repo: workspace.repo,
        environment: environment.name,
        opencode_config_path: opencodeConfigPath,
        session_id: latestSessionId,
        worktree_path: workspacePaths.agent_worktree_path,
        host_worktree_path: workspacePaths.host_worktree_path,
      });
    }
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to build agent command for ${workspace.name}: ${formatError(error)}`,
    );
  }

  if (command.agent_type === "claude") {
    try {
      await dependencies.ensureClaudeTrustedPaths({
        environment,
        workspace_paths: workspacePaths,
        repo: repoConfig,
        claude_config_dir: command.agent_env.CLAUDE_CONFIG_DIR,
      });
    } catch (error: unknown) {
      reportWarnings(dependencies.reportWarning, [
        `Failed to pre-trust Claude workspace paths for ${workspace.name}: ${formatError(error)}`,
      ]);
    }
  }

  if (command.agent_type === "codex") {
    try {
      await dependencies.ensureCodexTrustedPath({
        environment,
        workspace_paths: workspacePaths,
        codex_home: command.agent_env.CODEX_HOME,
      });
    } catch (error: unknown) {
      reportWarnings(dependencies.reportWarning, [
        `Failed to pre-trust Codex workspace path for ${workspace.name}: ${formatError(error)}`,
      ]);
    }
  }

  reportWarnings(dependencies.reportWarning, command.warnings);

  let paneCommand: string;
  try {
    paneCommand = formatAgentPaneCommand(
      command,
      await shouldReuseConnectedVmPane(workspace, existingPaneInfo, command),
    );
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to format agent command for ${workspace.name}: ${formatError(error)}`,
    );
  }

  try {
    await dependencies.sendKeysToPane({
      pane_id: agentPaneId,
      command: paneCommand,
    });
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to send agent command to tmux pane for ${workspace.name}: ${formatError(error)}`,
    );
  }

  if (command.post_launch_prompt !== undefined) {
    try {
      await sendPostLaunchPromptToPane(
        agentPaneId,
        command.post_launch_prompt,
        command,
        workspace.name,
        dependencies,
      );
    } catch (error: unknown) {
      reportWarnings(dependencies.reportWarning, [
        `Failed to send bootstrap prompt to ${workspace.name}: ${formatError(error)}`,
      ]);
    }
  }

  const startedAt = dependencies.now().toISOString();
  const updatedWorkspace: WorkspaceRecord = {
    ...workspace,
    agent_name: command.agent_name,
    agent_type: command.agent_type,
    agent_runtime: command.runtime,
    environment_name: environment.name ?? null,
    environment_kind: environment.kind,
    guest_worktree_path: workspacePaths.guest_worktree_path,
    agent_pane_process: command.pane_process_name,
    agent_env: command.agent_env,
    agent_sessions: [
      ...workspace.agent_sessions,
      buildNextAgentSession(command, startedAt),
    ],
    updated_at: startedAt,
  };

  try {
    const persistedWorkspace = await dependencies.writeWorkspaceRecord(updatedWorkspace);

    if (isFreshLaunch) {
      try {
        reportWarnings(
          dependencies.reportWarning,
          await dependencies.runGitHubLifecycle({
            repo: persistedWorkspace.repo,
            source_kind: persistedWorkspace.source_kind,
            source_number: persistedWorkspace.source_number,
          }),
        );
      } catch (error: unknown) {
        reportWarnings(dependencies.reportWarning, [
          `Failed to apply GitHub lifecycle automation for ${persistedWorkspace.name}: ${formatError(error)}`,
        ]);
      }
    }

    return persistedWorkspace;
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to update workspace state for ${workspace.name}: ${formatError(error)}`,
    );
  }
}

export function registerResumeWorkspaceTool(
  server: McpServer,
  config: PitchConfig,
  dependencies: Partial<ResumeWorkspaceDependencies> = {},
): void {
  server.registerTool(
    "resume_workspace",
    {
      description:
        "Resume or relaunch the coding agent in an existing active workspace.",
      inputSchema: ResumeWorkspaceInputSchema,
      outputSchema: WorkspaceRecordSchema,
    },
    async (args) => {
      const warnings: string[] = [];
      const workspace = await resumeWorkspace(args, config, {
        ...dependencies,
        reportWarning: (warning) => warnings.push(warning),
      });
      return buildWorkspaceToolResponse(workspace, warnings);
    },
  );
}
