import {
  getAgentStatusSnapshot,
  type AgentRuntimeState,
  type AgentSessionState,
  type AgentStatusSnapshot,
} from "./agent-status.js";
import {
  focusTmuxPane,
  listTmuxPanes,
  type TmuxPaneListing,
} from "./tmux.js";
import {
  listWorkspaceRecords,
  type WorkspaceRecord,
} from "./workspace-state.js";

export interface AgentPaneMatch {
  session_name: string;
  window_name: string;
  pane_index: number;
  pane_id: string;
  pane_tty: string;
  current_command: string;
  current_path: string;
}

export interface AgentViewEntry {
  agent_type: AgentSessionState["agent_type"];
  agent_name?: string;
  tmux_session_name?: string;
  tmux_window_name?: string;
  state: AgentRuntimeState;
  session_id: string;
  session_key: string;
  last_event: string;
  updated_at: string;
  cwd?: string;
  tty?: string;
  tmux?: AgentPaneMatch;
}

export interface AgentsView {
  summary: AgentStatusSnapshot["summary"];
  agents: AgentViewEntry[];
}

export interface AgentShortcutEntry {
  key: string;
  agent: AgentViewEntry;
}

export interface AgentsViewDependencies {
  getAgentStatusSnapshot: typeof getAgentStatusSnapshot;
  listTmuxPanes: typeof listTmuxPanes;
  focusTmuxPane: typeof focusTmuxPane;
  listWorkspaceRecords: typeof listWorkspaceRecords;
}

const defaultDependencies: AgentsViewDependencies = {
  getAgentStatusSnapshot,
  listTmuxPanes,
  focusTmuxPane,
  listWorkspaceRecords,
};

const AGENT_SHORTCUT_KEYS = "asdfghjkl;wertyuiopzxcvbnm1234567890";
const HOST_AGENT_STATUS_SOURCE = "host";

function normalizeTty(tty: string | undefined): string | undefined {
  if (tty === undefined) {
    return undefined;
  }

  const trimmed = tty.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  return trimmed.startsWith("/dev/") ? trimmed.slice(5) : trimmed;
}

function statePriority(state: AgentRuntimeState): number {
  switch (state) {
    case "question":
      return 0;
    case "running":
      return 1;
    case "error":
      return 2;
    case "idle":
      return 3;
  }
}

function compareEntries(left: AgentViewEntry, right: AgentViewEntry): number {
  const priorityDifference = statePriority(left.state) - statePriority(right.state);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  return right.updated_at.localeCompare(left.updated_at);
}

function compareUpdatedAtDescending(
  left: { updated_at: string },
  right: { updated_at: string },
): number {
  return right.updated_at.localeCompare(left.updated_at);
}

function toPaneMatch(pane: TmuxPaneListing): AgentPaneMatch {
  return {
    session_name: pane.session_name,
    window_name: pane.window_name,
    pane_index: pane.pane_index,
    pane_id: pane.pane_id,
    pane_tty: normalizeTty(pane.pane_tty) ?? pane.pane_tty,
    current_command: pane.current_command,
    current_path: pane.current_path,
  };
}

function shortenSessionId(sessionId: string): string {
  return sessionId.length <= 12 ? sessionId : sessionId.slice(0, 12);
}

function getEntryIdentity(entry: AgentViewEntry): string | undefined {
  if (entry.tmux?.pane_id !== undefined) {
    return `${entry.agent_type}:pane:${entry.tmux.pane_id}`;
  }

  if (entry.tty !== undefined) {
    return `${entry.agent_type}:tty:${entry.tty}`;
  }

  if (entry.cwd !== undefined) {
    return `${entry.agent_type}:cwd:${entry.cwd}`;
  }

  return undefined;
}

function getWorkspaceLookupKeys(workspace: WorkspaceRecord): string[] {
  const keys = [`tmux:${workspace.tmux_session}:${workspace.tmux_window}`];

  if (workspace.worktree_path.length > 0) {
    keys.push(`cwd:${workspace.worktree_path}`);
  }
  if (
    workspace.guest_worktree_path !== undefined &&
    workspace.guest_worktree_path.length > 0
  ) {
    keys.push(`cwd:${workspace.guest_worktree_path}`);
  }

  return keys;
}

function resolveWorkspace(
  session: AgentSessionState,
  workspacesByKey: Map<string, WorkspaceRecord>,
): WorkspaceRecord | undefined {
  if (
    session.tmux_session !== undefined &&
    session.tmux_window !== undefined
  ) {
    const workspace = workspacesByKey.get(
      `tmux:${session.tmux_session}:${session.tmux_window}`,
    );
    if (workspace !== undefined) {
      return workspace;
    }
  }

  if (session.cwd !== undefined) {
    const workspace = workspacesByKey.get(`cwd:${session.cwd}`);
    if (workspace !== undefined) {
      return workspace;
    }
  }

  return undefined;
}

export async function getAgentsView(
  dependencyOverrides: Partial<AgentsViewDependencies> = {},
): Promise<AgentsView> {
  const dependencies: AgentsViewDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const [snapshot, panes, workspaces] = await Promise.all([
    dependencies.getAgentStatusSnapshot(),
    dependencies.listTmuxPanes(),
    dependencies.listWorkspaceRecords({ status: "active" }),
  ]);

  const hostSummary =
    snapshot.sources.find((source) => source.source === HOST_AGENT_STATUS_SOURCE)
      ?.summary ?? snapshot.summary;

  const workspacesByKey = new Map<string, WorkspaceRecord>();
  for (const workspace of workspaces) {
    for (const key of getWorkspaceLookupKeys(workspace)) {
      if (!workspacesByKey.has(key)) {
        workspacesByKey.set(key, workspace);
      }
    }
  }

  const panesByTty = new Map<string, TmuxPaneListing>();
  for (const pane of panes) {
    const tty = normalizeTty(pane.pane_tty);
    if (tty !== undefined && !panesByTty.has(tty)) {
      panesByTty.set(tty, pane);
    }
  }

  const mappedAgents = snapshot.sessions
    .sort(compareUpdatedAtDescending)
    .map((session: AgentSessionState): AgentViewEntry => {
      const tty = normalizeTty(session.tty);
      const pane = tty !== undefined ? panesByTty.get(tty) : undefined;
      const workspace = resolveWorkspace(session, workspacesByKey);
      const tmuxSessionName = session.tmux_session ?? workspace?.tmux_session;
      const tmuxWindowName = session.tmux_window ?? workspace?.tmux_window;

      return {
        agent_type: session.agent_type,
        agent_name: workspace?.agent_name,
        tmux_session_name: tmuxSessionName,
        tmux_window_name: tmuxWindowName,
        state: session.state,
        session_id: session.session_id,
        session_key: shortenSessionId(session.session_id),
        last_event: session.last_event,
        updated_at: session.updated_at,
        cwd: session.cwd,
        tty,
        tmux:
          session.tmux_session !== undefined &&
          session.tmux_window !== undefined &&
          session.tmux_pane_id !== undefined &&
          session.tmux_pane_index !== undefined
            ? {
                session_name: session.tmux_session,
                window_name: session.tmux_window,
                pane_index: session.tmux_pane_index,
                pane_id: session.tmux_pane_id,
                pane_tty: tty ?? "-",
                current_command: pane?.current_command ?? "",
                current_path: pane?.current_path ?? session.cwd ?? "",
              }
            : pane !== undefined
              ? toPaneMatch(pane)
              : undefined,
      };
    });

  const latestByIdentity = new Map<string, AgentViewEntry>();
  const uniqueAgents: AgentViewEntry[] = [];
  for (const agent of mappedAgents) {
    const identity = getEntryIdentity(agent);
    if (identity === undefined) {
      uniqueAgents.push(agent);
      continue;
    }

    if (!latestByIdentity.has(identity)) {
      latestByIdentity.set(identity, agent);
    }
  }

  const agents = [
    ...latestByIdentity.values(),
    ...uniqueAgents,
  ].sort(compareEntries);

  return {
    summary: hostSummary,
    agents,
  };
}

export async function jumpToAgentSession(
  sessionSelector: string,
  dependencyOverrides: Partial<AgentsViewDependencies> = {},
): Promise<AgentViewEntry> {
  const dependencies: AgentsViewDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const view = await getAgentsView(dependencyOverrides);
  const exactMatch = view.agents.find(
    (entry) =>
      entry.session_id === sessionSelector ||
      entry.session_key === sessionSelector,
  );
  const prefixMatches = view.agents.filter(
    (entry) =>
      entry.session_id.startsWith(sessionSelector) ||
      entry.session_key.startsWith(sessionSelector),
  );
  const agent =
    exactMatch ??
    (prefixMatches.length === 1 ? prefixMatches[0] : undefined);

  if (agent === undefined) {
    if (prefixMatches.length > 1) {
      throw new Error(
        `Multiple live agents match session selector: ${sessionSelector}`,
      );
    }
    throw new Error(
      `No live tracked agent found for session selector: ${sessionSelector}`,
    );
  }

  if (agent.tmux === undefined) {
    throw new Error(`No live tmux pane found for session: ${agent.session_id}`);
  }

  await dependencies.focusTmuxPane({
    session_name: agent.tmux.session_name,
    window_name: agent.tmux.window_name,
    pane_id: agent.tmux.pane_id,
  });

  return agent;
}

export function buildAgentShortcutEntries(
  agents: AgentViewEntry[],
): AgentShortcutEntry[] {
  return agents
    .filter((agent) => agent.tmux !== undefined)
    .slice(0, AGENT_SHORTCUT_KEYS.length)
    .map((agent, index) => ({
      key: AGENT_SHORTCUT_KEYS[index],
      agent,
    }));
}
