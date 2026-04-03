import { randomUUID } from "node:crypto";
import type {
  AgentType,
  ExecutionEnvironmentKind,
  PitchConfig,
  VmSshExecutionEnvironmentConfig,
} from "./config.js";
import {
  mapAgentArgsForEnvironment,
  buildVmSshCommand,
  mapAgentEnvForEnvironment,
  mapAdditionalPathsForEnvironment,
  resolveExecutionEnvironment,
  type ResolvedExecutionEnvironment,
  type ResolvedWorkspacePaths,
} from "./execution-environment.js";

export type SupportedAgentType = AgentType;
export type SupportedRuntime = "native" | "docker";
export type SupportedEnvironmentKind = ExecutionEnvironmentKind;

export interface AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand;
  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand;
}

export interface BuildStartCommandInput {
  config: PitchConfig;
  agent: string;
  repo?: string;
  opencode_config_path?: string;
  environment?: string;
  workspace_name: string;
  worktree_path: string;
  host_worktree_path?: string;
  initial_prompt?: string;
  override_args?: string[];
  runtime?: SupportedRuntime;
  session_id?: string;
}

export interface BuildResumeCommandInput {
  config: PitchConfig;
  agent: string;
  repo?: string;
  opencode_config_path?: string;
  environment?: string;
  workspace_name: string;
  session_id: string;
  worktree_path?: string;
  host_worktree_path?: string;
  runtime?: SupportedRuntime;
}

export interface BuiltAgentCommand {
  agent_name: string;
  agent_type: SupportedAgentType;
  runtime: SupportedRuntime;
  environment_name?: string;
  environment_kind: SupportedEnvironmentKind;
  command: string[];
  env: Record<string, string>;
  agent_env: Record<string, string>;
  pane_process_name: string;
  pane_reuse_command?: string;
  host_marker_path?: string;
  session_id?: string;
  post_launch_prompt?: string;
  warnings: string[];
}

interface ResolvedAgentTarget {
  agent_name: string;
  agent_type: SupportedAgentType;
  runtime: SupportedRuntime;
  args: string[];
  env: Record<string, string>;
  warnings: string[];
}

interface RuntimeWrappedCommand {
  command: string[];
  pane_process_name: string;
}

export function resolveAgentEnv(
  config: PitchConfig,
  agentName: string,
  repo: string | undefined,
): Record<string, string> {
  return resolveAgentTarget(config, agentName, repo).env;
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

export function getAdditionalPathWarnings(
  agentType: SupportedAgentType,
  additionalPaths: string[],
): string[] {
  void agentType;
  void additionalPaths;
  return [];
}

function buildAdditionalPathArgs(
  agentType: SupportedAgentType,
  additionalPaths: string[],
): string[] {
  if (additionalPaths.length === 0) {
    return [];
  }

  if (agentType === "claude" || agentType === "codex") {
    return additionalPaths.flatMap((path) => ["--add-dir", path]);
  }

  return [];
}

function wrapRuntimeCommand(
  agentType: SupportedAgentType,
  runtime: SupportedRuntime,
  command: string[],
): RuntimeWrappedCommand {
  if (runtime === "native") {
    return {
      command,
      pane_process_name: AGENT_BINARIES[agentType],
    };
  }

  return {
    command: ["agent-en-place", agentType, ...command.slice(1)],
    pane_process_name: "agent-en-place",
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
  environmentDefaultRuntime?: SupportedRuntime,
  additionalPaths?: string[],
): ResolvedAgentTarget {
  const repoConfig = resolveRepoConfig(config, repo);
  const agentConfig = config.agents[agentName];
  if (agentConfig === undefined) {
    throw new AgentLauncherError(`Agent is not configured: ${agentName}`);
  }

  const repoDefaults = repoConfig?.agent_defaults;
  const repoOverride = repoConfig?.agent_overrides[agentName];
  const additionalPathArgs = buildAdditionalPathArgs(
    agentConfig.type,
    additionalPaths ?? repoConfig?.additional_paths ?? [],
  );
  const warnings = getAdditionalPathWarnings(
    agentConfig.type,
    additionalPaths ?? repoConfig?.additional_paths ?? [],
  );

  return {
    agent_name: agentName,
    agent_type: agentConfig.type,
    runtime:
      runtimeOverride ??
      environmentDefaultRuntime ??
      repoOverride?.runtime ??
      repoDefaults?.runtime ??
      agentConfig.runtime,
    args: [
      ...agentConfig.args,
      ...additionalPathArgs,
      ...(repoDefaults?.args ?? []),
      ...(repoOverride?.args ?? []),
    ],
    env: {
      ...agentConfig.env,
      ...(repoDefaults?.env ?? {}),
      ...(repoOverride?.env ?? {}),
    },
    warnings,
  };
}

function resolveStartEnvironment(
  input: BuildStartCommandInput,
): {
  environment: ResolvedExecutionEnvironment;
  workspace_paths: ResolvedWorkspacePaths;
  additional_paths: string[];
} {
  const environment = resolveExecutionEnvironment(
    input.config,
    input.repo,
    input.environment,
  );
  const hostWorktreePath = input.host_worktree_path ?? input.worktree_path;
  const workspacePaths: ResolvedWorkspacePaths = {
    host_worktree_path: hostWorktreePath,
    agent_worktree_path: input.worktree_path,
    guest_worktree_path: input.worktree_path,
  };
  const repoConfig = resolveRepoConfig(input.config, input.repo);

  return {
    environment,
    workspace_paths: workspacePaths,
    additional_paths: mapAdditionalPathsForEnvironment(
      repoConfig?.additional_paths ?? [],
      environment,
      workspacePaths,
    ),
  };
}

function resolveResumeEnvironment(
  input: BuildResumeCommandInput,
): {
  environment: ResolvedExecutionEnvironment;
  workspace_paths: ResolvedWorkspacePaths | null;
} {
  const environment = resolveExecutionEnvironment(
    input.config,
    input.repo,
    input.environment,
  );

  if (input.worktree_path === undefined && input.host_worktree_path === undefined) {
    return {
      environment,
      workspace_paths: null,
    };
  }

  return {
    environment,
    workspace_paths: {
      host_worktree_path:
        input.host_worktree_path ?? input.worktree_path ?? "",
      agent_worktree_path: input.worktree_path ?? input.host_worktree_path ?? "",
      guest_worktree_path: input.worktree_path ?? input.host_worktree_path ?? "",
    },
  };
}

function wrapExecutionEnvironmentCommand(
  environment: ResolvedExecutionEnvironment,
  runtimeCommand: RuntimeWrappedCommand,
  agentEnv: Record<string, string>,
  workspaceName: string,
  workspacePaths: ResolvedWorkspacePaths | null,
  runBootstrap: boolean,
): {
  command: string[];
  env: Record<string, string>;
  pane_process_name: string;
  pane_reuse_command?: string;
  host_marker_path?: string;
} {
  if (environment.kind !== "vm-ssh") {
    return {
      command: runtimeCommand.command,
      env: agentEnv,
      pane_process_name: runtimeCommand.pane_process_name,
    };
  }

  if (workspacePaths === null || environment.config === undefined) {
    throw new AgentLauncherError(
      "vm-ssh execution environments require host and guest worktree paths",
    );
  }

  const vmCommand = buildVmSshCommand({
    environment: environment.config as VmSshExecutionEnvironmentConfig,
    workspace_name: workspaceName,
    workspace_paths: workspacePaths,
    agent_command: runtimeCommand.command,
    agent_env: agentEnv,
    run_bootstrap: runBootstrap,
  });

  return {
    command: vmCommand.command,
    env: {},
    pane_process_name: vmCommand.pane_process_name,
    pane_reuse_command: vmCommand.reuse_command,
    host_marker_path: vmCommand.host_marker_path,
  };
}

function buildClaudeStartCommand(
  input: BuildStartCommandInput,
  resolved: ResolvedAgentTarget,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths,
): BuiltAgentCommand {
  const sessionId = input.session_id ?? randomUUID();
  const agentEnv = mapAgentEnvForEnvironment(
    resolved.env,
    environment,
    workspacePaths,
  );
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
    ...(input.initial_prompt === undefined ? [] : [input.initial_prompt]),
  ];

  const runtimeCommand = wrapRuntimeCommand("claude", resolved.runtime, command);
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    runtimeCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    true,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "claude",
    runtime: resolved.runtime,
    environment_name: environment.name,
    environment_kind: environment.kind,
    command: executionCommand.command,
    env: executionCommand.env,
    agent_env: agentEnv,
    pane_process_name: executionCommand.pane_process_name,
    pane_reuse_command: executionCommand.pane_reuse_command,
    host_marker_path: executionCommand.host_marker_path,
    session_id: sessionId,
    warnings: resolved.warnings,
  };
}

function buildClaudeResumeCommand(
  input: BuildResumeCommandInput,
  resolved: ResolvedAgentTarget,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths | null,
): BuiltAgentCommand {
  const command = [AGENT_BINARIES.claude, "--resume", input.session_id];
  const agentEnv =
    workspacePaths === null
      ? resolved.env
      : mapAgentEnvForEnvironment(resolved.env, environment, workspacePaths);
  const runtimeCommand = wrapRuntimeCommand("claude", resolved.runtime, command);
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    runtimeCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    false,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "claude",
    runtime: resolved.runtime,
    environment_name: environment.name,
    environment_kind: environment.kind,
    command: executionCommand.command,
    env: executionCommand.env,
    agent_env: agentEnv,
    pane_process_name: executionCommand.pane_process_name,
    pane_reuse_command: executionCommand.pane_reuse_command,
    host_marker_path: executionCommand.host_marker_path,
    session_id: input.session_id,
    warnings: resolved.warnings,
  };
}

function buildCodexStartCommand(
  input: BuildStartCommandInput,
  resolved: ResolvedAgentTarget,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths,
): BuiltAgentCommand {
  const agentEnv = mapAgentEnvForEnvironment(
    resolved.env,
    environment,
    workspacePaths,
  );
  const layeredArgs = withoutReservedArgs(
    [...resolved.args, ...(input.override_args ?? [])],
    ["--cd", "-C"],
  );

  const command = [
    AGENT_BINARIES.codex,
    ...layeredArgs,
    "--cd",
    input.worktree_path,
    ...(input.initial_prompt === undefined ? [] : [input.initial_prompt]),
  ];

  const runtimeCommand = wrapRuntimeCommand("codex", resolved.runtime, command);
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    runtimeCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    true,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "codex",
    runtime: resolved.runtime,
    environment_name: environment.name,
    environment_kind: environment.kind,
    command: executionCommand.command,
    env: executionCommand.env,
    agent_env: agentEnv,
    pane_process_name: executionCommand.pane_process_name,
    pane_reuse_command: executionCommand.pane_reuse_command,
    host_marker_path: executionCommand.host_marker_path,
    warnings: resolved.warnings,
  };
}

function buildCodexResumeCommand(
  input: BuildResumeCommandInput,
  resolved: ResolvedAgentTarget,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths | null,
): BuiltAgentCommand {
  const command = [AGENT_BINARIES.codex, "resume", input.session_id];
  const agentEnv =
    workspacePaths === null
      ? resolved.env
      : mapAgentEnvForEnvironment(resolved.env, environment, workspacePaths);
  const runtimeCommand = wrapRuntimeCommand("codex", resolved.runtime, command);
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    runtimeCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    false,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "codex",
    runtime: resolved.runtime,
    environment_name: environment.name,
    environment_kind: environment.kind,
    command: executionCommand.command,
    env: executionCommand.env,
    agent_env: agentEnv,
    pane_process_name: executionCommand.pane_process_name,
    pane_reuse_command: executionCommand.pane_reuse_command,
    host_marker_path: executionCommand.host_marker_path,
    session_id: input.session_id,
    warnings: resolved.warnings,
  };
}

function buildOpencodeStartCommand(
  input: BuildStartCommandInput,
  resolved: ResolvedAgentTarget,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths,
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
    ...(attachMode || input.initial_prompt === undefined
      ? []
      : ["--prompt", input.initial_prompt]),
    ...(attachMode ? ["--dir", input.worktree_path] : [input.worktree_path]),
  ];

  const agentEnv = mapAgentEnvForEnvironment(
    {
      ...resolved.env,
      ...(input.opencode_config_path === undefined
        ? {}
        : { OPENCODE_CONFIG: input.opencode_config_path }),
    },
    environment,
    workspacePaths,
  );
  const runtimeCommand = wrapRuntimeCommand(
    "opencode",
    resolved.runtime,
    command,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    runtimeCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    true,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "opencode",
    runtime: resolved.runtime,
    environment_name: environment.name,
    environment_kind: environment.kind,
    command: executionCommand.command,
    env: executionCommand.env,
    agent_env: agentEnv,
    pane_process_name: executionCommand.pane_process_name,
    pane_reuse_command: executionCommand.pane_reuse_command,
    host_marker_path: executionCommand.host_marker_path,
    post_launch_prompt: attachMode ? input.initial_prompt : undefined,
    warnings: resolved.warnings,
  };
}

function buildOpencodeResumeCommand(
  input: BuildResumeCommandInput,
  resolved: ResolvedAgentTarget,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths | null,
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
  const agentEnv =
    workspacePaths === null
      ? {
          ...resolved.env,
          ...(input.opencode_config_path === undefined
            ? {}
            : { OPENCODE_CONFIG: input.opencode_config_path }),
        }
      : mapAgentEnvForEnvironment(
          {
            ...resolved.env,
            ...(input.opencode_config_path === undefined
              ? {}
              : { OPENCODE_CONFIG: input.opencode_config_path }),
          },
          environment,
          workspacePaths,
        );
  const runtimeCommand = wrapRuntimeCommand(
    "opencode",
    resolved.runtime,
    command,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    runtimeCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    false,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "opencode",
    runtime: resolved.runtime,
    environment_name: environment.name,
    environment_kind: environment.kind,
    command: executionCommand.command,
    env: executionCommand.env,
    agent_env: agentEnv,
    pane_process_name: executionCommand.pane_process_name,
    pane_reuse_command: executionCommand.pane_reuse_command,
    host_marker_path: executionCommand.host_marker_path,
    session_id: input.session_id,
    warnings: resolved.warnings,
  };
}

class ClaudeLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const { environment, workspace_paths, additional_paths } =
      resolveStartEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
      environment.default_runtime,
      additional_paths,
    );
    const mappedResolved = {
      ...resolved,
      args: mapAgentArgsForEnvironment(
        resolved.args,
        environment,
        workspace_paths,
      ),
    };
    if (resolved.agent_type !== "claude") {
      throw new AgentLauncherError(
        `Claude launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildClaudeStartCommand(
      input,
      mappedResolved,
      environment,
      workspace_paths,
    );
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const { environment, workspace_paths } = resolveResumeEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
      environment.default_runtime,
    );
    const mappedResolved = {
      ...resolved,
      args:
        workspace_paths === null
          ? resolved.args
          : mapAgentArgsForEnvironment(
              resolved.args,
              environment,
              workspace_paths,
            ),
    };
    if (resolved.agent_type !== "claude") {
      throw new AgentLauncherError(
        `Claude launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildClaudeResumeCommand(
      input,
      mappedResolved,
      environment,
      workspace_paths,
    );
  }
}

class CodexLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const { environment, workspace_paths, additional_paths } =
      resolveStartEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
      environment.default_runtime,
      additional_paths,
    );
    const mappedResolved = {
      ...resolved,
      args: mapAgentArgsForEnvironment(
        resolved.args,
        environment,
        workspace_paths,
      ),
    };
    if (resolved.agent_type !== "codex") {
      throw new AgentLauncherError(
        `Codex launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildCodexStartCommand(
      input,
      mappedResolved,
      environment,
      workspace_paths,
    );
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const { environment, workspace_paths } = resolveResumeEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
      environment.default_runtime,
    );
    const mappedResolved = {
      ...resolved,
      args:
        workspace_paths === null
          ? resolved.args
          : mapAgentArgsForEnvironment(
              resolved.args,
              environment,
              workspace_paths,
            ),
    };
    if (resolved.agent_type !== "codex") {
      throw new AgentLauncherError(
        `Codex launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildCodexResumeCommand(
      input,
      mappedResolved,
      environment,
      workspace_paths,
    );
  }
}

class OpencodeLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const { environment, workspace_paths, additional_paths } =
      resolveStartEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
      environment.default_runtime,
      additional_paths,
    );
    const mappedResolved = {
      ...resolved,
      args: mapAgentArgsForEnvironment(
        resolved.args,
        environment,
        workspace_paths,
      ),
    };
    if (resolved.agent_type !== "opencode") {
      throw new AgentLauncherError(
        `OpenCode launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildOpencodeStartCommand(
      input,
      mappedResolved,
      environment,
      workspace_paths,
    );
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const { environment, workspace_paths } = resolveResumeEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
      input.runtime,
      environment.default_runtime,
    );
    const mappedResolved = {
      ...resolved,
      args:
        workspace_paths === null
          ? resolved.args
          : mapAgentArgsForEnvironment(
              resolved.args,
              environment,
              workspace_paths,
            ),
    };
    if (resolved.agent_type !== "opencode") {
      throw new AgentLauncherError(
        `OpenCode launcher cannot build commands for ${resolved.agent_type}`,
      );
    }

    return buildOpencodeResumeCommand(
      input,
      mappedResolved,
      environment,
      workspace_paths,
    );
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
  const agentConfig = input.config.agents[input.agent];
  if (agentConfig === undefined) {
    throw new AgentLauncherError(`Agent is not configured: ${input.agent}`);
  }

  return getAgentLauncher(agentConfig.type).buildStartCommand(input);
}

export function buildAgentResumeCommand(
  input: BuildResumeCommandInput,
): BuiltAgentCommand {
  const agentConfig = input.config.agents[input.agent];
  if (agentConfig === undefined) {
    throw new AgentLauncherError(`Agent is not configured: ${input.agent}`);
  }

  return getAgentLauncher(agentConfig.type).buildResumeCommand(input);
}
