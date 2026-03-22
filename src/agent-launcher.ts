import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  AgentProfile,
  PitchConfig,
} from "./config.js";

export type SupportedAgentType = "claude" | "codex";
export type SupportedRuntime = "native" | "docker";

export interface AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand;
  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand;
}

export interface BuildStartCommandInput {
  config: PitchConfig;
  agent: string;
  workspace_name: string;
  worktree_path: string;
  overrides?: Record<string, string>;
  runtime?: SupportedRuntime;
  session_id?: string;
}

export interface BuildResumeCommandInput {
  config: PitchConfig;
  agent: string;
  session_id: string;
  overrides?: Record<string, string>;
  runtime?: SupportedRuntime;
}

export interface BuiltAgentCommand {
  agent_type: SupportedAgentType;
  runtime: SupportedRuntime;
  command: string[];
  env: Record<string, string>;
  session_id?: string;
  profile_name?: string;
}

interface ResolvedAgentTarget {
  agent_type: SupportedAgentType;
  runtime: SupportedRuntime;
  defaults: Record<string, string>;
  env: Record<string, string>;
  profile_name?: string;
}

interface AgentRuntimeCommand {
  command: string[];
  env: Record<string, string>;
}

export class AgentLauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLauncherError";
  }
}

const AGENT_BINARIES: Record<SupportedAgentType, string> = {
  claude: "claude",
  codex: "codex",
};

function isSupportedAgentType(agent: string): agent is SupportedAgentType {
  return agent === "claude" || agent === "codex";
}

function toFlagArgs(defaults: Record<string, string>): string[] {
  return Object.entries(defaults).flatMap(([key, value]) => [`--${key}`, value]);
}

function wrapRuntimeCommand(
  agentType: SupportedAgentType,
  runtime: SupportedRuntime,
  command: string[],
  env: Record<string, string>,
): AgentRuntimeCommand {
  if (runtime === "native") {
    return {
      command,
      env,
    };
  }

  return {
    command: ["agent-en-place", agentType, ...command],
    env,
  };
}

function resolveAgentTarget(
  config: PitchConfig,
  agent: string,
  runtimeOverride?: SupportedRuntime,
): ResolvedAgentTarget {
  const profile = config.agent_profiles[agent];
  if (profile !== undefined) {
    return resolveProfileTarget(config, agent, profile, runtimeOverride);
  }

  if (!isSupportedAgentType(agent)) {
    throw new AgentLauncherError(`Unsupported agent type: ${agent}`);
  }

  const agentConfig = config.agents[agent];
  if (agentConfig === undefined) {
    throw new AgentLauncherError(`Agent is not configured: ${agent}`);
  }

  return {
    agent_type: agent,
    runtime: runtimeOverride ?? agentConfig.runtime,
    defaults: { ...agentConfig.defaults },
    env: { ...agentConfig.env },
  };
}

function resolveProfileTarget(
  config: PitchConfig,
  profileName: string,
  profile: AgentProfile,
  runtimeOverride?: SupportedRuntime,
): ResolvedAgentTarget {
  if (!isSupportedAgentType(profile.agent)) {
    throw new AgentLauncherError(
      `Agent profile ${profileName} references unsupported agent type: ${profile.agent}`,
    );
  }

  const baseAgent = config.agents[profile.agent];
  if (baseAgent === undefined) {
    throw new AgentLauncherError(
      `Agent profile ${profileName} references unconfigured agent: ${profile.agent}`,
    );
  }

  return {
    agent_type: profile.agent,
    runtime: runtimeOverride ?? profile.runtime ?? baseAgent.runtime,
    defaults: {
      ...baseAgent.defaults,
      ...profile.defaults,
    },
    env: {
      ...baseAgent.env,
      ...profile.env,
    },
    profile_name: profileName,
  };
}

function buildClaudeStartCommand(
  input: BuildStartCommandInput,
  resolved: ResolvedAgentTarget,
): BuiltAgentCommand {
  const sessionId = input.session_id ?? randomUUID();
  const layeredDefaults = {
    ...resolved.defaults,
    ...(input.overrides ?? {}),
  };

  const command = [
    AGENT_BINARIES.claude,
    "--session-id",
    sessionId,
    "--cd",
    input.worktree_path,
    "--name",
    input.workspace_name,
    ...toFlagArgs(layeredDefaults),
  ];

  const runtimeCommand = wrapRuntimeCommand(
    "claude",
    resolved.runtime,
    command,
    resolved.env,
  );

  return {
    agent_type: "claude",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    session_id: sessionId,
    profile_name: resolved.profile_name,
  };
}

function buildClaudeResumeCommand(
  input: BuildResumeCommandInput,
  resolved: ResolvedAgentTarget,
): BuiltAgentCommand {
  const command = [AGENT_BINARIES.claude, "--resume", input.session_id];
  const runtimeCommand = wrapRuntimeCommand(
    "claude",
    resolved.runtime,
    command,
    resolved.env,
  );

  return {
    agent_type: "claude",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    session_id: input.session_id,
    profile_name: resolved.profile_name,
  };
}

function buildCodexStartCommand(
  input: BuildStartCommandInput,
  resolved: ResolvedAgentTarget,
): BuiltAgentCommand {
  const layeredDefaults = {
    ...resolved.defaults,
    ...(input.overrides ?? {}),
  };

  const command = [
    AGENT_BINARIES.codex,
    "--cd",
    input.worktree_path,
    ...toFlagArgs(layeredDefaults),
  ];

  const runtimeCommand = wrapRuntimeCommand(
    "codex",
    resolved.runtime,
    command,
    resolved.env,
  );

  return {
    agent_type: "codex",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    profile_name: resolved.profile_name,
  };
}

function buildCodexResumeCommand(
  input: BuildResumeCommandInput,
  resolved: ResolvedAgentTarget,
): BuiltAgentCommand {
  const command = [AGENT_BINARIES.codex, "resume", input.session_id];
  const runtimeCommand = wrapRuntimeCommand(
    "codex",
    resolved.runtime,
    command,
    resolved.env,
  );

  return {
    agent_type: "codex",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    session_id: input.session_id,
    profile_name: resolved.profile_name,
  };
}

class ClaudeLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(input.config, input.agent, input.runtime);
    if (resolved.agent_type !== "claude") {
      throw new AgentLauncherError(
        `Claude launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildClaudeStartCommand(input, resolved);
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(input.config, input.agent, input.runtime);
    if (resolved.agent_type !== "claude") {
      throw new AgentLauncherError(
        `Claude launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildClaudeResumeCommand(input, resolved);
  }
}

class CodexLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(input.config, input.agent, input.runtime);
    if (resolved.agent_type !== "codex") {
      throw new AgentLauncherError(
        `Codex launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildCodexStartCommand(input, resolved);
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(input.config, input.agent, input.runtime);
    if (resolved.agent_type !== "codex") {
      throw new AgentLauncherError(
        `Codex launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildCodexResumeCommand(input, resolved);
  }
}

export const claudeLauncher = new ClaudeLauncher();
export const codexLauncher = new CodexLauncher();

export function getAgentLauncher(agentType: SupportedAgentType): AgentLauncher {
  if (agentType === "claude") {
    return claudeLauncher;
  }

  return codexLauncher;
}

export function buildAgentStartCommand(
  input: BuildStartCommandInput,
): BuiltAgentCommand {
  const resolved = resolveAgentTarget(input.config, input.agent, input.runtime);
  return getAgentLauncher(resolved.agent_type).buildStartCommand(input);
}

export function buildAgentResumeCommand(
  input: BuildResumeCommandInput,
): BuiltAgentCommand {
  const resolved = resolveAgentTarget(input.config, input.agent, input.runtime);
  return getAgentLauncher(resolved.agent_type).buildResumeCommand(input);
}
