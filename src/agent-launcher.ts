import { randomUUID } from "node:crypto";
import type {
  AgentType,
  PitchConfig,
} from "./config.js";

export type SupportedAgentType = AgentType;
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
  worktree_path?: string;
  runtime?: SupportedRuntime;
}

export interface BuiltAgentCommand {
  agent_name: string;
  agent_type: SupportedAgentType;
  runtime: SupportedRuntime;
  command: string[];
  env: Record<string, string>;
  session_id?: string;
}

interface ResolvedAgentTarget {
  agent_name: string;
  agent_type: SupportedAgentType;
  runtime: SupportedRuntime;
  args: string[];
  env: Record<string, string>;
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
  opencode: "opencode",
};

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

function withoutStandaloneFlags(
  args: string[],
  reservedFlags: string[],
): string[] {
  const reservedFlagSet = new Set(reservedFlags);
  return args.filter((arg) => !reservedFlagSet.has(arg));
}

function resolveRepoConfig(
  config: PitchConfig,
  repo: string | undefined,
): PitchConfig["repos"][string] | null {
  if (repo === undefined) {
    return null;
  }

  const repoConfig = config.repos[repo];
  if (repoConfig === undefined) {
    throw new AgentLauncherError(`Repo is not configured: ${repo}`);
  }

  return repoConfig;
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

function assertSupportedRuntime(
  agentType: SupportedAgentType,
  runtime: SupportedRuntime,
): void {
  if (agentType === "opencode" && runtime === "docker") {
    throw new AgentLauncherError(
      "OpenCode does not support the docker runtime yet",
    );
  }
}

function resolveAgentTarget(
  config: PitchConfig,
  agentName: string,
  repo: string | undefined,
  runtimeOverride?: SupportedRuntime,
): ResolvedAgentTarget {
  const repoConfig = resolveRepoConfig(config, repo);
  const agentConfig = config.agents[agentName];
  if (agentConfig === undefined) {
    throw new AgentLauncherError(`Agent is not configured: ${agentName}`);
  }

  const repoDefaults = repoConfig?.agent_defaults;
  const repoOverride = repoConfig?.agent_overrides[agentName];

  return {
    agent_name: agentName,
    agent_type: agentConfig.type,
    runtime:
      runtimeOverride ??
      repoOverride?.runtime ??
      repoDefaults?.runtime ??
      agentConfig.runtime,
    args: [
      ...agentConfig.args,
      ...(repoDefaults?.args ?? []),
      ...(repoOverride?.args ?? []),
    ],
    env: {
      ...agentConfig.env,
      ...(repoDefaults?.env ?? {}),
      ...(repoOverride?.env ?? {}),
    },
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
    agent_name: resolved.agent_name,
    agent_type: "claude",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    session_id: sessionId,
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
    agent_name: resolved.agent_name,
    agent_type: "claude",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    session_id: input.session_id,
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
    agent_name: resolved.agent_name,
    agent_type: "codex",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
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
    agent_name: resolved.agent_name,
    agent_type: "codex",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    session_id: input.session_id,
  };
}

function buildOpencodeStartCommand(
  input: BuildStartCommandInput,
  resolved: ResolvedAgentTarget,
): BuiltAgentCommand {
  assertSupportedRuntime("opencode", resolved.runtime);

  const argsWithoutBooleanFlags = withoutStandaloneFlags(
    [...resolved.args, ...(input.override_args ?? [])],
    ["--continue", "-c"],
  );

  const layeredArgs = withoutReservedArgs(
    argsWithoutBooleanFlags,
    ["--session", "-s"],
  );

  const attachMode = layeredArgs[0] === "attach";

  const sanitizedArgs = withoutReservedArgs(layeredArgs, ["--dir"]);

  const command = [
    AGENT_BINARIES.opencode,
    ...sanitizedArgs,
    ...(attachMode ? ["--dir", input.worktree_path] : [input.worktree_path]),
  ];

  const runtimeCommand = wrapRuntimeCommand(
    "opencode",
    resolved.runtime,
    command,
    resolved.env,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "opencode",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
  };
}

function buildOpencodeResumeCommand(
  input: BuildResumeCommandInput,
  resolved: ResolvedAgentTarget,
): BuiltAgentCommand {
  assertSupportedRuntime("opencode", resolved.runtime);

  const attachMode = resolved.args[0] === "attach";
  const argsWithoutBooleanFlags = withoutStandaloneFlags(
    resolved.args,
    ["--continue", "-c"],
  );
  const sanitizedArgs = withoutReservedArgs(
    argsWithoutBooleanFlags,
    ["--session", "-s", "--dir"],
  );

  if (attachMode && input.worktree_path === undefined) {
    throw new AgentLauncherError(
      "OpenCode attach-mode resume requires a worktree path",
    );
  }

  const command = [
    AGENT_BINARIES.opencode,
    ...sanitizedArgs,
    ...(attachMode ? ["--dir", input.worktree_path!] : []),
    "--session",
    input.session_id,
  ];
  const runtimeCommand = wrapRuntimeCommand(
    "opencode",
    resolved.runtime,
    command,
    resolved.env,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "opencode",
    runtime: resolved.runtime,
    command: runtimeCommand.command,
    env: runtimeCommand.env,
    session_id: input.session_id,
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

class OpencodeLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
    );
    if (resolved.agent_type !== "opencode") {
      throw new AgentLauncherError(
        `OpenCode launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildOpencodeStartCommand(input, resolved);
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
    );
    if (resolved.agent_type !== "opencode") {
      throw new AgentLauncherError(
        `OpenCode launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildOpencodeResumeCommand(input, resolved);
  }
}

export const claudeLauncher = new ClaudeLauncher();
export const codexLauncher = new CodexLauncher();
export const opencodeLauncher = new OpencodeLauncher();

export function getAgentLauncher(agentType: SupportedAgentType): AgentLauncher {
  if (agentType === "claude") {
    return claudeLauncher;
  }

  if (agentType === "codex") {
    return codexLauncher;
  }

  return opencodeLauncher;
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
