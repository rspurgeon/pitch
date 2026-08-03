import { basename } from "node:path";
import {
  getAgentsView,
  type AgentViewEntry,
  type AgentsView,
} from "./agents.js";
import {
  getAgentStatusSnapshot,
  type AgentRuntimeState,
  type AgentSessionState,
  type AgentStatusSnapshot,
} from "./agent-status.js";

export interface WaybarStatusDependencies {
  getAgentsView: typeof getAgentsView;
  getAgentStatusSnapshot: typeof getAgentStatusSnapshot;
}

export interface RenderWaybarStatusOptions {
  pulseFrame?: boolean;
}

export interface WatchWaybarStatusOptions {
  refreshIntervalMs?: number;
  pulseIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WaybarStatusOutput {
  write(chunk: string): void;
}

interface DisplayAgent {
  agent_type: AgentSessionState["agent_type"];
  state: AgentRuntimeState;
  session_id: string;
  last_event: string;
  updated_at: string;
  label: string;
  cwd?: string;
  tmux_session?: string;
  tmux_window?: string;
}

interface WaybarPayload {
  text: string;
  tooltip: string;
  class: string[];
}

const defaultDependencies: WaybarStatusDependencies = {
  getAgentsView,
  getAgentStatusSnapshot,
};

const PREFIX_SYMBOL = "🤖";
const RUNNING_SYMBOL = "●";
const RUNNING_DIM_SYMBOL = "·";
const QUESTION_SYMBOL = "?";
const GROUP_DIVIDER_SYMBOL = "‖";

const PREFIX_COLOR = "#B7BDB5";
const RUNNING_COLOR = "#7DAF7D";
const QUESTION_COLOR = "#E5C07B";
const IDLE_COLOR = "#61AFEF";
const ERROR_COLOR = "#E06C75";
const DIVIDER_COLOR = "#B7BDB5";

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function span(color: string, value: string): string {
  return `<span foreground="${color}">${escapeMarkup(value)}</span>`;
}

function sanitizeLabel(label: string): string {
  return label.trim().replaceAll(/\s+/g, "-");
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

function compareAgents(left: DisplayAgent, right: DisplayAgent): number {
  const priorityDifference = statePriority(left.state) - statePriority(right.state);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }

  const homeSessionDifference = Number(isHomeSession(left)) - Number(isHomeSession(right));
  if (homeSessionDifference !== 0) {
    return homeSessionDifference;
  }

  return left.label.localeCompare(right.label);
}

function isHomeSession(agent: DisplayAgent): boolean {
  return process.env.HOME !== undefined && agent.cwd === process.env.HOME;
}

function getAgentViewLabel(agent: AgentViewEntry): string {
  const tmuxWindow = agent.tmux?.window_name ?? agent.tmux_window_name;
  if (tmuxWindow !== undefined && tmuxWindow.length > 0) {
    return sanitizeLabel(tmuxWindow);
  }

  if (agent.cwd !== undefined && agent.cwd.length > 0) {
    return sanitizeLabel(basename(agent.cwd));
  }

  return sanitizeLabel(agent.agent_name ?? agent.agent_type);
}

function fromAgentView(agent: AgentViewEntry): DisplayAgent {
  return {
    agent_type: agent.agent_type,
    state: agent.state,
    session_id: agent.session_id,
    last_event: agent.last_event,
    updated_at: agent.updated_at,
    label: getAgentViewLabel(agent),
    cwd: agent.cwd,
    tmux_session: agent.tmux?.session_name ?? agent.tmux_session_name,
    tmux_window: agent.tmux?.window_name ?? agent.tmux_window_name,
  };
}

function getSessionLabel(session: AgentSessionState): string {
  if (session.tmux_window !== undefined && session.tmux_window.length > 0) {
    return sanitizeLabel(session.tmux_window);
  }

  if (session.cwd !== undefined && session.cwd.length > 0) {
    return sanitizeLabel(basename(session.cwd));
  }

  return sanitizeLabel(session.agent_type);
}

function fromSnapshotSession(session: AgentSessionState): DisplayAgent {
  return {
    agent_type: session.agent_type,
    state: session.state,
    session_id: session.session_id,
    last_event: session.last_event,
    updated_at: session.updated_at,
    label: getSessionLabel(session),
    cwd: session.cwd,
    tmux_session: session.tmux_session,
    tmux_window: session.tmux_window,
  };
}

function countByState(agents: DisplayAgent[]): Record<AgentRuntimeState, number> {
  return {
    running: agents.filter((agent) => agent.state === "running").length,
    question: agents.filter((agent) => agent.state === "question").length,
    idle: agents.filter((agent) => agent.state === "idle").length,
    error: agents.filter((agent) => agent.state === "error").length,
  };
}

async function getDisplayAgents(
  dependencies: WaybarStatusDependencies,
): Promise<DisplayAgent[]> {
  try {
    const view: AgentsView = await dependencies.getAgentsView();
    const viewAgents = view.agents.map(fromAgentView);
    try {
      const snapshot: AgentStatusSnapshot = await dependencies.getAgentStatusSnapshot();
      return mergeDisplayAgents(viewAgents, snapshot.sessions.map(fromSnapshotSession));
    } catch {
      return viewAgents;
    }
  } catch {
    const snapshot: AgentStatusSnapshot = await dependencies.getAgentStatusSnapshot();
    return snapshot.sessions.map(fromSnapshotSession);
  }
}

function mergeDisplayAgents(
  preferredAgents: DisplayAgent[],
  fallbackAgents: DisplayAgent[],
): DisplayAgent[] {
  const agentsBySessionId = new Map<string, DisplayAgent>();
  for (const agent of fallbackAgents) {
    agentsBySessionId.set(agent.session_id, agent);
  }
  for (const agent of preferredAgents) {
    agentsBySessionId.set(agent.session_id, agent);
  }

  return [...agentsBySessionId.values()];
}

function getModuleClasses(counts: Record<AgentRuntimeState, number>): string[] {
  const classes = ["pitch-agents"];
  if (counts.question > 0) {
    classes.push("question");
  } else if (counts.error > 0) {
    classes.push("error");
  } else if (counts.running > 0) {
    classes.push("running");
  } else if (counts.idle > 0) {
    classes.push("idle");
  } else {
    classes.push("empty");
  }
  return classes;
}

function buildText(
  agents: DisplayAgent[],
  options: RenderWaybarStatusOptions = {},
): string {
  if (agents.length === 0) {
    return "";
  }

  const groups: string[] = [];
  const hasRunningAgents = agents.some((agent) => agent.state === "running");
  const pulseFrame =
    options.pulseFrame ?? Math.floor(Date.now() / 1000) % 2 === 0;
  const runningSymbol = pulseFrame ? RUNNING_SYMBOL : RUNNING_DIM_SYMBOL;

  for (const state of ["question", "running", "idle", "error"] as const) {
    const color =
      state === "question"
        ? QUESTION_COLOR
        : state === "running"
          ? RUNNING_COLOR
          : state === "idle"
            ? IDLE_COLOR
            : ERROR_COLOR;
    const symbol =
      state === "question"
        ? `${QUESTION_SYMBOL} `
        : state === "running"
          ? ""
          : state === "error"
            ? "! "
            : "";
    const stateAgents = agents
      .filter((agent) => agent.state === state)
      .sort(compareAgents);

    if (stateAgents.length === 0) {
      continue;
    }

    groups.push(
      stateAgents
        .map((agent) => span(color, `${symbol}${agent.label}`))
        .join(` ${span(color, "|")} `),
    );
  }

  const prefix = [span(PREFIX_COLOR, PREFIX_SYMBOL)];
  if (hasRunningAgents) {
    prefix.push(span(RUNNING_COLOR, runningSymbol));
  }

  return [...prefix, groups.join(` ${span(DIVIDER_COLOR, GROUP_DIVIDER_SYMBOL)} `)].join(" ");
}

function buildTooltip(agents: DisplayAgent[]): string {
  const counts = countByState(agents);
  const lines = [
    `Pitch Agents  R:${counts.running} Q:${counts.question} I:${counts.idle} E:${counts.error}`,
  ];

  if (agents.length === 0) {
    lines.push("No live agents tracked.");
    return lines.join("\n");
  }

  lines.push("");
  for (const agent of [...agents].sort(compareAgents)) {
    const tmuxLabel =
      agent.tmux_session !== undefined && agent.tmux_window !== undefined
        ? ` ${agent.tmux_session}:${agent.tmux_window}`
        : "";
    lines.push(`${agent.state.padEnd(8)} ${agent.label} (${agent.agent_type})${tmuxLabel}`);
    if (agent.cwd !== undefined) {
      lines.push(`  ${agent.cwd}`);
    }
  }

  return lines.join("\n");
}

export async function renderWaybarStatus(
  dependencyOverrides: Partial<WaybarStatusDependencies> = {},
  options: RenderWaybarStatusOptions = {},
): Promise<string> {
  const dependencies: WaybarStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const agents = await getDisplayAgents(dependencies);
  const payload: WaybarPayload = {
    text: buildText(agents, options),
    tooltip: buildTooltip(agents),
    class: getModuleClasses(countByState(agents)),
  };

  return JSON.stringify(payload);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (isAborted(signal)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function buildPayload(
  agents: DisplayAgent[],
  options: RenderWaybarStatusOptions,
): string {
  const payload: WaybarPayload = {
    text: buildText(agents, options),
    tooltip: buildTooltip(agents),
    class: getModuleClasses(countByState(agents)),
  };

  return JSON.stringify(payload);
}

export async function watchWaybarStatus(
  output: WaybarStatusOutput,
  dependencyOverrides: Partial<WaybarStatusDependencies> = {},
  options: WatchWaybarStatusOptions = {},
): Promise<void> {
  const dependencies: WaybarStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const refreshIntervalMs = options.refreshIntervalMs ?? 5_000;
  const pulseIntervalMs = options.pulseIntervalMs ?? 1_000;
  let agents = await getDisplayAgents(dependencies);
  let nextRefreshAt = Date.now() + refreshIntervalMs;
  let pulseFrame = true;

  while (!isAborted(options.signal)) {
    output.write(`${buildPayload(agents, { pulseFrame })}\n`);
    pulseFrame = !pulseFrame;

    await sleep(pulseIntervalMs, options.signal);
    if (isAborted(options.signal)) {
      break;
    }

    if (Date.now() >= nextRefreshAt) {
      agents = await getDisplayAgents(dependencies);
      nextRefreshAt = Date.now() + refreshIntervalMs;
    }
  }
}
