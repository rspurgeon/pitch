import {
  refreshAgentStatusSummary,
  type AgentStatusSummary,
} from "./agent-status.js";
import { getAgentsView, type AgentViewEntry } from "./agents.js";

export interface StatusRightInput {
  separator?: string;
  tmuxSession?: string;
  tmuxWindow?: string;
}

export interface StatusRightDependencies {
  refreshAgentStatusSummary: typeof refreshAgentStatusSummary;
  getAgentsView: typeof getAgentsView;
}

const defaultDependencies: StatusRightDependencies = {
  refreshAgentStatusSummary,
  getAgentsView,
};

const TMUX_FORMAT = "tmux";
const DEFAULT_RUNNING_COLOR = "#7DAF7D";
const DEFAULT_QUESTION_COLOR = "#E5C07B";
const DEFAULT_IDLE_COLOR = "#61AFEF";
const DEFAULT_ERROR_COLOR = "#E06C75";
const DEFAULT_PREFIX_COLOR = "#B7BDB5";
const DEFAULT_DOT_SYMBOL = "●";
const DEFAULT_RUNNING_DIM_SYMBOL = "·";
const DEFAULT_QUESTION_SYMBOL = "?";
const DEFAULT_PREFIX_SYMBOL = "🤖";

function isTmuxFormatEnabled(): boolean {
  return process.env.PITCH_STATUS_RIGHT_FORMAT === TMUX_FORMAT;
}

function formatPlainSummary(summary: AgentStatusSummary): string {
  const segments: string[] = [];

  if (summary.counts.running > 0) {
    segments.push(`R:${summary.counts.running}`);
  }
  if (summary.counts.question > 0) {
    segments.push(`Q:${summary.counts.question}`);
  }
  if (summary.counts.idle > 0) {
    segments.push(`I:${summary.counts.idle}`);
  }
  if (summary.counts.error > 0) {
    segments.push(`E:${summary.counts.error}`);
  }

  return segments.join(" ");
}

function buildTmuxSegment(
  symbol: string,
  count: number,
  color: string,
): string {
  return `#[fg=${color}]${symbol}${count}#[default]`;
}

function sanitizeAgentLabel(label: string): string {
  return label.replaceAll(/\s+/g, "-");
}

function getTmuxLabel(agent: AgentViewEntry): string | undefined {
  const sessionNameRaw = agent.tmux?.session_name ?? agent.tmux_session_name;
  const windowNameRaw = agent.tmux?.window_name ?? agent.tmux_window_name;
  if (sessionNameRaw === undefined || windowNameRaw === undefined) {
    return undefined;
  }

  const sessionName = sanitizeAgentLabel(sessionNameRaw);
  const windowName = sanitizeAgentLabel(windowNameRaw);
  return sessionName === windowName
    ? sessionName
    : `${sessionName}:${windowName}`;
}

function getAgentLabel(agent: AgentViewEntry): string {
  return getTmuxLabel(agent) ?? sanitizeAgentLabel(agent.agent_type);
}

function getAgentsByState(
  agents: AgentViewEntry[],
  state: AgentViewEntry["state"],
): AgentViewEntry[] {
  return agents.filter((agent) => agent.state === state);
}

function summarizeAgents(agents: AgentViewEntry[]): AgentStatusSummary {
  const counts = {
    running: 0,
    question: 0,
    idle: 0,
    error: 0,
  };

  for (const agent of agents) {
    counts[agent.state] += 1;
  }

  return {
    generated_at: new Date().toISOString(),
    active_sessions: agents.length,
    counts,
  };
}

function agentMatchesTmuxContext(
  agent: AgentViewEntry,
  context: StatusRightInput,
): boolean {
  if (context.tmuxSession === undefined && context.tmuxWindow === undefined) {
    return true;
  }

  const sessionName = agent.tmux?.session_name ?? agent.tmux_session_name;
  const windowName = agent.tmux?.window_name ?? agent.tmux_window_name;

  if (
    context.tmuxSession !== undefined && sessionName !== context.tmuxSession
  ) {
    return false;
  }

  if (context.tmuxWindow !== undefined && windowName !== context.tmuxWindow) {
    return false;
  }

  return true;
}

function buildAgentStateSegments(
  agents: AgentViewEntry[],
  color: string,
  symbol: string,
): string[] {
  const agentSegments = agents.map(
    (agent) => `#[fg=${color}]${symbol}${getAgentLabel(agent)}#[default]`,
  );
  const segments: string[] = [];

  for (const [index, segment] of agentSegments.entries()) {
    if (index > 0) {
      segments.push(`#[fg=${color}]|#[default]`);
    }
    segments.push(segment);
  }

  return segments;
}

function formatTmuxSummary(
  summary: AgentStatusSummary,
  runningAgents: AgentViewEntry[],
  idleAgents: AgentViewEntry[],
): string {
  const segments: string[] = [];
  const prefix = process.env.PITCH_STATUS_RIGHT_PREFIX_SYMBOL;
  const pulseFrame = Math.floor(Date.now() / 1000) % 2 === 0;

  if (prefix !== "") {
    segments.push(
      buildTmuxSegment(
        prefix ?? DEFAULT_PREFIX_SYMBOL,
        0,
        process.env.PITCH_STATUS_RIGHT_PREFIX_COLOR ?? DEFAULT_PREFIX_COLOR,
      ).replace(/0#\[default\]$/, "#[default]"),
    );
  }

  if (runningAgents.length > 0) {
    const runningSymbol = pulseFrame
      ? (process.env.PITCH_STATUS_RIGHT_RUNNING_SYMBOL ?? DEFAULT_DOT_SYMBOL)
      : (process.env.PITCH_STATUS_RIGHT_RUNNING_DIM_SYMBOL ??
          DEFAULT_RUNNING_DIM_SYMBOL);
    const runningColor =
      process.env.PITCH_STATUS_RIGHT_RUNNING_COLOR ?? DEFAULT_RUNNING_COLOR;
    segments.push(
      ...buildAgentStateSegments(runningAgents, runningColor, runningSymbol),
    );
  } else if (summary.counts.running > 0) {
    segments.push(
      buildTmuxSegment(
        pulseFrame
          ? (process.env.PITCH_STATUS_RIGHT_RUNNING_SYMBOL ?? DEFAULT_DOT_SYMBOL)
          : (process.env.PITCH_STATUS_RIGHT_RUNNING_DIM_SYMBOL ??
              DEFAULT_RUNNING_DIM_SYMBOL),
        summary.counts.running,
        process.env.PITCH_STATUS_RIGHT_RUNNING_COLOR ?? DEFAULT_RUNNING_COLOR,
      ),
    );
  }

  if (idleAgents.length > 0) {
    segments.push(
      ...buildAgentStateSegments(
        idleAgents,
        process.env.PITCH_STATUS_RIGHT_IDLE_COLOR ?? DEFAULT_IDLE_COLOR,
        process.env.PITCH_STATUS_RIGHT_IDLE_SYMBOL ?? DEFAULT_DOT_SYMBOL,
      ),
    );
  } else if (summary.counts.idle > 0) {
    segments.push(
      buildTmuxSegment(
        process.env.PITCH_STATUS_RIGHT_IDLE_SYMBOL ?? DEFAULT_DOT_SYMBOL,
        summary.counts.idle,
        process.env.PITCH_STATUS_RIGHT_IDLE_COLOR ?? DEFAULT_IDLE_COLOR,
      ),
    );
  }
  if (summary.counts.question > 0) {
    segments.push(
      buildTmuxSegment(
        process.env.PITCH_STATUS_RIGHT_QUESTION_SYMBOL ??
          DEFAULT_QUESTION_SYMBOL,
        summary.counts.question,
        process.env.PITCH_STATUS_RIGHT_QUESTION_COLOR ?? DEFAULT_QUESTION_COLOR,
      ),
    );
  }
  if (summary.counts.error > 0) {
    segments.push(
      buildTmuxSegment(
        process.env.PITCH_STATUS_RIGHT_ERROR_SYMBOL ?? DEFAULT_DOT_SYMBOL,
        summary.counts.error,
        process.env.PITCH_STATUS_RIGHT_ERROR_COLOR ?? DEFAULT_ERROR_COLOR,
      ),
    );
  }

  return segments.join(" ");
}

export async function renderStatusRight(
  input: StatusRightInput = {},
  dependencyOverrides: Partial<StatusRightDependencies> = {},
): Promise<string> {
  const dependencies: StatusRightDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const summary = await dependencies.refreshAgentStatusSummary();
  const shouldScopeToTmuxContext =
    input.tmuxSession !== undefined || input.tmuxWindow !== undefined;
  const agents = (isTmuxFormatEnabled() || shouldScopeToTmuxContext)
    ? (await dependencies.getAgentsView()).agents.filter((agent) =>
        agentMatchesTmuxContext(agent, input),
      )
    : [];
  const scopedSummary = shouldScopeToTmuxContext
    ? summarizeAgents(agents)
    : summary;

  if (scopedSummary.active_sessions === 0) {
    return "";
  }

  const runningAgents = getAgentsByState(agents, "running");
  const idleAgents = getAgentsByState(agents, "idle");
  const rendered = isTmuxFormatEnabled()
    ? formatTmuxSummary(scopedSummary, runningAgents, idleAgents)
    : formatPlainSummary(scopedSummary);
  if (rendered.length === 0) {
    return "";
  }

  return input.separator !== undefined && input.separator.length > 0
    ? `${rendered}${input.separator}`
    : rendered;
}
