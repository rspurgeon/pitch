import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type {
  AgentType,
  ExecutionEnvironmentKind,
  PitchConfig,
  SandboxConfig,
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
export type SupportedEnvironmentKind = ExecutionEnvironmentKind;

export interface AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand;
  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand;
}

export interface BuildStartCommandInput {
  config: PitchConfig;
  agent: string;
  repo?: string;
  sandbox?: string;
  opencode_config_path?: string;
  environment?: string;
  workspace_name: string;
  worktree_path: string;
  host_worktree_path?: string;
  initial_prompt?: string;
  override_args?: string[];
  session_id?: string;
}

export interface BuildResumeCommandInput {
  config: PitchConfig;
  agent: string;
  repo?: string;
  sandbox?: string;
  opencode_config_path?: string;
  environment?: string;
  workspace_name: string;
  session_id: string;
  worktree_path?: string;
  host_worktree_path?: string;
}

export interface BuiltAgentCommand {
  agent_name: string;
  agent_type: SupportedAgentType;
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
  args: string[];
  env: Record<string, string>;
  warnings: string[];
}

interface BaseWrappedCommand {
  command: string[];
  pane_process_name: string;
}

interface SandboxWrappedCommand {
  command: string[];
  pane_process_name: string;
}

type ExecutableReadDirectoryResolver = (agentBinary: string) => string[];

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

function runPathLookup(command: string, args: string[]): string | null {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return output.length === 0 ? null : output;
  } catch {
    return null;
  }
}

function defaultExecutableReadDirectoryResolver(
  agentBinary: string,
): string[] {
  const directories = new Set<string>();
  const discoveredPaths = [
    runPathLookup("mise", ["which", agentBinary]),
    runPathLookup("which", [agentBinary]),
  ];

  for (const executablePath of discoveredPaths) {
    if (executablePath === null || !isAbsolute(executablePath)) {
      continue;
    }

    directories.add(dirname(executablePath));

    try {
      directories.add(dirname(realpathSync(executablePath)));
    } catch {
      // Keep the original path when the symlink target cannot be resolved.
    }
  }

  return [...directories];
}

let executableReadDirectoryResolver: ExecutableReadDirectoryResolver =
  defaultExecutableReadDirectoryResolver;

export function setExecutableReadDirectoryResolverForTests(
  resolver: ExecutableReadDirectoryResolver | null,
): void {
  executableReadDirectoryResolver =
    resolver ?? defaultExecutableReadDirectoryResolver;
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

function resolveSandboxConfig(
  config: PitchConfig,
  repo: string | undefined,
  requestedSandbox?: string,
): SandboxConfig | null {
  const repoConfig = resolveRepoConfig(config, repo);
  const sandboxName = requestedSandbox ?? repoConfig?.sandbox;

  if (sandboxName === undefined) {
    return null;
  }

  const sandboxConfig = config.sandboxes[sandboxName];
  if (sandboxConfig === undefined) {
    throw new AgentLauncherError(
      `Sandbox is not configured: ${sandboxName}`,
    );
  }

  return sandboxConfig;
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

function wrapBaseCommand(
  agentType: SupportedAgentType,
  command: string[],
): BaseWrappedCommand {
  return {
    command,
    pane_process_name: AGENT_BINARIES[agentType],
  };
}

function resolveNonoProfile(
  agentType: SupportedAgentType,
  sandbox: SandboxConfig,
): string {
  const agentSpecificProfile = sandbox.profiles?.[agentType];
  if (agentSpecificProfile !== undefined) {
    return agentSpecificProfile;
  }

  if (sandbox.profile !== undefined) {
    return sandbox.profile;
  }

  if (agentType === "claude") {
    return "claude-code";
  }

  if (agentType === "codex") {
    return "codex";
  }

  return "opencode";
}

function hasArgWithValue(
  args: string[],
  flag: string,
  value: string,
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === `${flag}=${value}`) {
      return true;
    }

    if (arg === flag && args[index + 1] === value) {
      return true;
    }
  }

  return false;
}

function validateSandboxCompatibility(
  agentType: SupportedAgentType,
  args: string[],
  sandbox: SandboxConfig | null,
): void {
  if (sandbox === null) {
    return;
  }

  if (
    agentType === "claude" &&
    hasArgWithValue(args, "--permission-mode", "bypassPermissions")
  ) {
    throw new AgentLauncherError(
      "Claude cannot use --permission-mode bypassPermissions when sandboxing is enabled",
    );
  }
}

function wrapSandboxCommand(
  agentType: SupportedAgentType,
  args: string[],
  sandbox: SandboxConfig | null,
  worktreePath: string | undefined,
  readablePaths: string[],
  command: BaseWrappedCommand,
): SandboxWrappedCommand {
  if (sandbox === null) {
    return command;
  }

  if (worktreePath === undefined) {
    throw new AgentLauncherError(
      `${sandbox.provider} sandboxing requires a worktree path`,
    );
  }

  validateSandboxCompatibility(agentType, args, sandbox);

  const wrappedCommand = [
    sandbox.provider,
    "run",
    "--profile",
    resolveNonoProfile(agentType, sandbox),
    "--workdir",
    worktreePath,
    "--allow-cwd",
    ...readablePaths.flatMap((path) => ["--read", path]),
    ...(sandbox.network_profile === undefined
      ? []
      : ["--network-profile", sandbox.network_profile]),
    ...(sandbox.capability_elevation ? ["--capability-elevation"] : []),
    ...(sandbox.rollback ? ["--rollback"] : []),
    "--",
    ...command.command,
  ];

  return {
    command: wrappedCommand,
    pane_process_name: sandbox.provider,
  };
}

function resolveSandboxReadablePaths(
  agentType: SupportedAgentType,
  environment: ResolvedExecutionEnvironment,
  sandbox: SandboxConfig | null,
): string[] {
  if (sandbox === null || environment.kind !== "host") {
    return [];
  }

  return executableReadDirectoryResolver(AGENT_BINARIES[agentType]);
}

function resolveAgentTarget(
  config: PitchConfig,
  agentName: string,
  repo: string | undefined,
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
  sandbox: SandboxConfig | null;
  workspace_paths: ResolvedWorkspacePaths;
  additional_paths: string[];
} {
  const environment = resolveExecutionEnvironment(
    input.config,
    input.repo,
    input.environment,
  );
  const sandbox = resolveSandboxConfig(
    input.config,
    input.repo,
    input.sandbox,
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
    sandbox,
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
  sandbox: SandboxConfig | null;
  workspace_paths: ResolvedWorkspacePaths | null;
} {
  const environment = resolveExecutionEnvironment(
    input.config,
    input.repo,
    input.environment,
  );
  const sandbox = resolveSandboxConfig(
    input.config,
    input.repo,
    input.sandbox,
  );

  if (input.worktree_path === undefined && input.host_worktree_path === undefined) {
    return {
      environment,
      sandbox,
      workspace_paths: null,
    };
  }

  return {
    environment,
    sandbox,
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
  baseCommand: BaseWrappedCommand,
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
      command: baseCommand.command,
      env: agentEnv,
      pane_process_name: baseCommand.pane_process_name,
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
    agent_command: baseCommand.command,
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
  sandbox: SandboxConfig | null,
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

  const baseCommand = wrapBaseCommand("claude", command);
  const sandboxReadablePaths = resolveSandboxReadablePaths(
    "claude",
    environment,
    sandbox,
  );
  const sandboxCommand = wrapSandboxCommand(
    "claude",
    resolved.args,
    sandbox,
    input.worktree_path,
    sandboxReadablePaths,
    baseCommand,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    sandboxCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    true,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "claude",
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
  sandbox: SandboxConfig | null,
  workspacePaths: ResolvedWorkspacePaths | null,
): BuiltAgentCommand {
  const command = [AGENT_BINARIES.claude, "--resume", input.session_id];
  const agentEnv =
    workspacePaths === null
      ? resolved.env
      : mapAgentEnvForEnvironment(resolved.env, environment, workspacePaths);
  const baseCommand = wrapBaseCommand("claude", command);
  const sandboxReadablePaths = resolveSandboxReadablePaths(
    "claude",
    environment,
    sandbox,
  );
  const sandboxCommand = wrapSandboxCommand(
    "claude",
    resolved.args,
    sandbox,
    input.worktree_path,
    sandboxReadablePaths,
    baseCommand,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    sandboxCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    false,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "claude",
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
  sandbox: SandboxConfig | null,
  workspacePaths: ResolvedWorkspacePaths,
): BuiltAgentCommand {
  const agentEnv = mapAgentEnvForEnvironment(
    resolved.env,
    environment,
    workspacePaths,
  );
  const layeredArgs = withoutReservedArgs(
    [...resolved.args, ...(input.override_args ?? [])],
    sandbox === null ? ["--cd", "-C"] : ["--cd", "-C", "--sandbox"],
  );

  const command = [
    AGENT_BINARIES.codex,
    ...layeredArgs,
    "--cd",
    input.worktree_path,
    ...(input.initial_prompt === undefined ? [] : [input.initial_prompt]),
  ];

  const baseCommand = wrapBaseCommand("codex", command);
  const sandboxReadablePaths = resolveSandboxReadablePaths(
    "codex",
    environment,
    sandbox,
  );
  const sandboxCommand = wrapSandboxCommand(
    "codex",
    resolved.args,
    sandbox,
    input.worktree_path,
    sandboxReadablePaths,
    baseCommand,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    sandboxCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    true,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "codex",
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
  sandbox: SandboxConfig | null,
  workspacePaths: ResolvedWorkspacePaths | null,
): BuiltAgentCommand {
  const command = [AGENT_BINARIES.codex, "resume", input.session_id];
  const agentEnv =
    workspacePaths === null
      ? resolved.env
      : mapAgentEnvForEnvironment(resolved.env, environment, workspacePaths);
  const baseCommand = wrapBaseCommand("codex", command);
  const sandboxReadablePaths = resolveSandboxReadablePaths(
    "codex",
    environment,
    sandbox,
  );
  const sandboxCommand = wrapSandboxCommand(
    "codex",
    resolved.args,
    sandbox,
    input.worktree_path,
    sandboxReadablePaths,
    baseCommand,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    sandboxCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    false,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "codex",
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
  sandbox: SandboxConfig | null,
  workspacePaths: ResolvedWorkspacePaths,
): BuiltAgentCommand {
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
  const baseCommand = wrapBaseCommand("opencode", command);
  const sandboxReadablePaths = resolveSandboxReadablePaths(
    "opencode",
    environment,
    sandbox,
  );
  const sandboxCommand = wrapSandboxCommand(
    "opencode",
    resolved.args,
    sandbox,
    input.worktree_path,
    sandboxReadablePaths,
    baseCommand,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    sandboxCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    true,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "opencode",
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
  sandbox: SandboxConfig | null,
  workspacePaths: ResolvedWorkspacePaths | null,
): BuiltAgentCommand {
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
  const baseCommand = wrapBaseCommand("opencode", command);
  const sandboxReadablePaths = resolveSandboxReadablePaths(
    "opencode",
    environment,
    sandbox,
  );
  const sandboxCommand = wrapSandboxCommand(
    "opencode",
    resolved.args,
    sandbox,
    input.worktree_path,
    sandboxReadablePaths,
    baseCommand,
  );
  const executionCommand = wrapExecutionEnvironmentCommand(
    environment,
    sandboxCommand,
    agentEnv,
    input.workspace_name,
    workspacePaths,
    false,
  );

  return {
    agent_name: resolved.agent_name,
    agent_type: "opencode",
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
    const { environment, sandbox, workspace_paths, additional_paths } =
      resolveStartEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
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
      sandbox,
      workspace_paths,
    );
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const { environment, sandbox, workspace_paths } =
      resolveResumeEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
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
      sandbox,
      workspace_paths,
    );
  }
}

class CodexLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const { environment, sandbox, workspace_paths, additional_paths } =
      resolveStartEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
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
      sandbox,
      workspace_paths,
    );
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const { environment, sandbox, workspace_paths } =
      resolveResumeEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
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
      sandbox,
      workspace_paths,
    );
  }
}

class OpencodeLauncher implements AgentLauncher {
  buildStartCommand(input: BuildStartCommandInput): BuiltAgentCommand {
    const { environment, sandbox, workspace_paths, additional_paths } =
      resolveStartEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
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
      sandbox,
      workspace_paths,
    );
  }

  buildResumeCommand(input: BuildResumeCommandInput): BuiltAgentCommand {
    const { environment, sandbox, workspace_paths } =
      resolveResumeEnvironment(input);
    const resolved = resolveAgentTarget(
      input.config,
      input.agent,
      input.repo,
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
      sandbox,
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
