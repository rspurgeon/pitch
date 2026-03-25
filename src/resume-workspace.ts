import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildAgentResumeCommand,
  buildAgentStartCommand,
  type BuiltAgentCommand,
} from "./agent-launcher.js";
import { buildBootstrapPrompt } from "./bootstrap-prompt.js";
import type { PitchConfig } from "./config.js";
import { findCodexSessionForWorkspace } from "./codex-session-store.js";
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

export const ResumeWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
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

function isCompatibleRunningAgentPane(
  workspace: WorkspaceRecord,
  paneInfo: TmuxPaneInfo | null,
): boolean {
  if (paneInfo === null || paneInfo.current_path !== workspace.worktree_path) {
    return false;
  }

  if (workspace.agent_runtime !== "native") {
    return false;
  }

  return paneInfo.current_command === workspace.agent_type;
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

  const agentName = resolveAgentName(workspace, input.agent);
  const isAgentContextChanged =
    input.agent !== undefined && input.agent !== currentWorkspaceAgentName(workspace);
  const trailingPendingSession = hasTrailingPendingSession(workspace);

  let latestSessionId = isAgentContextChanged || trailingPendingSession
    ? null
    : findLatestResumableSessionId(workspace);

  if (
    !isAgentContextChanged &&
    trailingPendingSession &&
    latestSessionId === null &&
    workspace.agent_type === "codex" &&
    workspace.agent_runtime === "native"
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
    trailingPendingSession &&
    latestSessionId === null &&
    workspace.agent_type === "opencode" &&
    workspace.agent_runtime === "native"
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
    latestSessionId === null &&
    findLatestPendingSessionIndex(workspace) === null &&
    isCompatibleRunningAgentPane(workspace, existingPaneInfo)
  ) {
    await dependencies.writeWorkspaceRecord(workspace);
    return workspace;
  }

  let command: BuiltAgentCommand;
  let isFreshLaunch = false;
  try {
    if (latestSessionId === null) {
      isFreshLaunch = true;
      command = dependencies.buildAgentStartCommand({
        config,
        agent: agentName,
        repo: workspace.repo,
        workspace_name: workspace.name,
        worktree_path: workspace.worktree_path,
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
        session_id: latestSessionId,
        worktree_path: workspace.worktree_path,
      });
    }
  } catch (error: unknown) {
    throw new ResumeWorkspaceError(
      `Failed to build agent command for ${workspace.name}: ${formatError(error)}`,
    );
  }
  reportWarnings(dependencies.reportWarning, command.warnings);

  let paneCommand: string;
  try {
    paneCommand = formatAgentPaneCommand(command);
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
    agent_env: command.env,
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
