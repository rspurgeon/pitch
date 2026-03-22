import { randomUUID } from "node:crypto";
import type {
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
  repo?: string;
  workspace_name: string;
  worktree_path: string;
  override_args?: string[];
  runtime?: SupportedRuntime;
  session_id?: string;
}

export interface BuildResumeCommandInput {
  config: PitchConfig;
  agent: string;
  repo?: string;
  session_id: string;
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
  args: string[];
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

function withoutReservedArgs(
  args: string[],
  reservedFlags: string[],
): string[] {
  const reservedFlagSet = new Set(reservedFlags);
  const filtered: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalSignIndex = arg.indexOf("=");
    const normalizedFlag =
      equalSignIndex === -1 ? arg : arg.slice(0, equalSignIndex);

    if (reservedFlagSet.has(normalizedFlag)) {
      if (equalSignIndex === -1) {
        index += 1;
      }
      continue;
    }

    filtered.push(arg);
  }

  return filtered;
}

function resolveRepoOverrides(
  config: PitchConfig,
  repo: string | undefined,
): Record<string, PitchConfig["repos"][string]["agent_overrides"][string]> {
  if (repo === undefined) {
    return {};
  }

  const repoConfig = config.repos[repo];
  if (repoConfig === undefined) {
    throw new AgentLauncherError(`Repo is not configured: ${repo}`);
  }

  return repoConfig.agent_overrides;
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
    command: ["agent-en-place", agentType, ...command.slice(1)],
    env,
  };
}

function resolveAgentTarget(
  config: PitchConfig,
  agent: string,
  repo: string | undefined,
  runtimeOverride?: SupportedRuntime,
): ResolvedAgentTarget {
  const repoOverrides = resolveRepoOverrides(config, repo);
  const profile = config.agent_profiles[agent];
  if (profile !== undefined) {
    return resolveProfileTarget(
      config,
      agent,
      profile,
      repoOverrides,
      runtimeOverride,
    );
  }

  if (!isSupportedAgentType(agent)) {
    throw new AgentLauncherError(`Unsupported agent type: ${agent}`);
  }

  const agentConfig = config.agents[agent];
  if (agentConfig === undefined) {
    throw new AgentLauncherError(`Agent is not configured: ${agent}`);
  }

  const repoOverride = repoOverrides[agent];

  return {
    agent_type: agent,
    runtime: runtimeOverride ?? repoOverride?.runtime ?? agentConfig.runtime,
    args: [...agentConfig.args, ...(repoOverride?.args ?? [])],
    env: {
      ...agentConfig.env,
      ...(repoOverride?.env ?? {}),
    },
  };
}

function resolveProfileTarget(
  config: PitchConfig,
  profileName: string,
  profile: AgentProfile,
  repoOverrides: Record<string, PitchConfig["repos"][string]["agent_overrides"][string]>,
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

  const baseRepoOverride = repoOverrides[profile.agent];
  const profileRepoOverride = repoOverrides[profileName];

  return {
    agent_type: profile.agent,
    runtime:
      runtimeOverride ??
      profileRepoOverride?.runtime ??
      baseRepoOverride?.runtime ??
      profile.runtime ??
      baseAgent.runtime,
    args: [
      ...baseAgent.args,
      ...profile.args,
      ...(baseRepoOverride?.args ?? []),
      ...(profileRepoOverride?.args ?? []),
    ],
    env: {
      ...baseAgent.env,
      ...profile.env,
      ...(baseRepoOverride?.env ?? {}),
      ...(profileRepoOverride?.env ?? {}),
    },
    profile_name: profileName,
  };
}

function buildClaudeStartCommand(
  input: BuildStartCommandInput,
  resolved: ResolvedAgentTarget,
): BuiltAgentCommand {
  const sessionId = input.session_id ?? randomUUID();
  const layeredArgs = withoutReservedArgs(
    [...resolved.args, ...(input.override_args ?? [])],
    ["--session-id", "--cd", "--name", "-n"],
  );

  const command = [
    AGENT_BINARIES.claude,
    ...layeredArgs,
    "--session-id",
    sessionId,
    "--name",
    input.workspace_name,
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
  const layeredArgs = withoutReservedArgs(
    [...resolved.args, ...(input.override_args ?? [])],
    ["--cd", "-C"],
  );

  const command = [
    AGENT_BINARIES.codex,
    ...layeredArgs,
    "--cd",
    input.worktree_path,
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
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
    );
    if (resolved.agent_type !== "claude") {
      throw new AgentLauncherError(
        `Claude launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildClaudeStartCommand(input, resolved);
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
    );
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
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
    );
    if (resolved.agent_type !== "codex") {
      throw new AgentLauncherError(
        `Codex launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildCodexStartCommand(input, resolved);
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
    );
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
  const resolved = resolveAgentTarget(
    input.config,
    input.agent,
    input.repo,
    input.runtime,
  );
  return getAgentLauncher(resolved.agent_type).buildStartCommand(input);
}

export function buildAgentResumeCommand(
  input: BuildResumeCommandInput,
): BuiltAgentCommand {
  const resolved = resolveAgentTarget(
    input.config,
    input.agent,
    input.repo,
    input.runtime,
  );
  return getAgentLauncher(resolved.agent_type).buildResumeCommand(input);
}
