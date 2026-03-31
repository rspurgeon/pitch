import { homedir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import type {
  AgentRuntime,
  ExecutionEnvironmentConfig,
  ExecutionEnvironmentKind,
  PitchConfig,
  RepoConfig,
  VmSshExecutionEnvironmentConfig,
} from "./config.js";
import { formatEnvAssignment, shellEscape } from "./shell.js";

export interface ResolvedExecutionEnvironment {
  name?: string;
  kind: ExecutionEnvironmentKind;
  default_runtime?: AgentRuntime;
  config?: ExecutionEnvironmentConfig;
}

export interface ResolvedWorkspacePaths {
  host_worktree_path: string;
  agent_worktree_path: string;
  guest_worktree_path: string;
}

export interface VmAgentStatePaths {
  host_marker_path: string;
  guest_marker_path: string;
}

export function buildVmAgentHostMarkerPath(worktreePath: string): string {
  return join(worktreePath, ".pitch", "vm-agent-active");
}

export class ExecutionEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionEnvironmentError";
  }
}

function expandShellPath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path.replace(/\$(\w+)|\$\{([^}]+)\}/g, (match, simple, wrapped) => {
    const key = simple ?? wrapped;
    const value = process.env[key];
    return value ?? match;
  });
}

function joinGuestPath(root: string, workspaceName: string): string {
  return posix.join(root, workspaceName);
}

function normalizeHostPath(path: string): string {
  return resolve(expandShellPath(path));
}

function normalizeGuestPath(path: string): string {
  return path;
}

function mapSharedHostPathToGuest(
  path: string,
  config: VmSshExecutionEnvironmentConfig,
): string | null {
  const normalizedPath = normalizeHostPath(path);

  for (const sharedPath of config.shared_paths) {
    const normalizedHostRoot = normalizeHostPath(sharedPath.host_path);
    if (!isSubpath(normalizedPath, normalizedHostRoot)) {
      continue;
    }

    const relativePath = relative(normalizedHostRoot, normalizedPath);
    const guestRoot = normalizeGuestPath(sharedPath.guest_path);
    return relativePath.length === 0
      ? guestRoot
      : posix.join(guestRoot, relativePath.split(sep).join("/"));
  }

  return null;
}

function isSubpath(path: string, parent: string): boolean {
  if (path === parent) {
    return true;
  }

  const relativePath = relative(parent, path);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

export function resolveExecutionEnvironment(
  config: PitchConfig,
  repoName: string | undefined,
  requestedEnvironment?: string,
): ResolvedExecutionEnvironment {
  const repoConfig =
    repoName === undefined ? undefined : config.repos[repoName];

  const environmentName =
    requestedEnvironment ??
    repoConfig?.default_environment ??
    config.defaults.environment;

  if (environmentName === undefined) {
    return {
      kind: "host",
    };
  }

  const environmentConfig = config.environments[environmentName];
  if (environmentConfig === undefined) {
    throw new ExecutionEnvironmentError(
      `Execution environment is not configured: ${environmentName}`,
    );
  }

  return {
    name: environmentName,
    kind: environmentConfig.kind,
    default_runtime: environmentConfig.default_runtime,
    config: environmentConfig,
  };
}

export function resolveWorkspacePaths(
  environment: ResolvedExecutionEnvironment,
  workspaceName: string,
  hostWorktreePath: string,
): ResolvedWorkspacePaths {
  if (environment.kind !== "vm-ssh") {
    return {
      host_worktree_path: hostWorktreePath,
      agent_worktree_path: hostWorktreePath,
      guest_worktree_path: hostWorktreePath,
    };
  }

  const config = environment.config as VmSshExecutionEnvironmentConfig | undefined;
  if (config === undefined) {
    throw new ExecutionEnvironmentError(
      "Missing vm-ssh execution environment config",
    );
  }

  const guestWorktreePath =
    mapSharedHostPathToGuest(hostWorktreePath, config) ??
    joinGuestPath(config.guest_workspace_root, workspaceName);

  return {
    host_worktree_path: hostWorktreePath,
    agent_worktree_path: guestWorktreePath,
    guest_worktree_path: guestWorktreePath,
  };
}

export function mapPathForEnvironment(
  path: string,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: Pick<ResolvedWorkspacePaths, "host_worktree_path" | "guest_worktree_path">,
): string | null {
  if (environment.kind !== "vm-ssh") {
    return path;
  }

  const normalizedPath = normalizeHostPath(path);
  const normalizedHostWorktree = normalizeHostPath(workspacePaths.host_worktree_path);
  if (isSubpath(normalizedPath, normalizedHostWorktree)) {
    const relativePath = relative(normalizedHostWorktree, normalizedPath);
    return relativePath.length === 0
      ? workspacePaths.guest_worktree_path
      : posix.join(workspacePaths.guest_worktree_path, relativePath.split(sep).join("/"));
  }

  const config = environment.config as VmSshExecutionEnvironmentConfig | undefined;
  if (config === undefined) {
    return null;
  }

  return mapSharedHostPathToGuest(path, config);
}

export function mapAdditionalPathsForEnvironment(
  additionalPaths: string[],
  environment: ResolvedExecutionEnvironment,
  workspacePaths: Pick<ResolvedWorkspacePaths, "host_worktree_path" | "guest_worktree_path">,
): string[] {
  return additionalPaths.map((path) => {
    const mappedPath = mapPathForEnvironment(path, environment, workspacePaths);
    if (mappedPath === null) {
      throw new ExecutionEnvironmentError(
        `Path is not shared into execution environment ${environment.name ?? environment.kind}: ${path}`,
      );
    }

    return mappedPath;
  });
}

function isLikelyPathValue(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("/");
}

export function mapAgentEnvForEnvironment(
  env: Record<string, string>,
  environment: ResolvedExecutionEnvironment,
  workspacePaths: Pick<ResolvedWorkspacePaths, "host_worktree_path" | "guest_worktree_path">,
): Record<string, string> {
  if (environment.kind !== "vm-ssh") {
    return env;
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (!isLikelyPathValue(value)) {
        return [key, value];
      }

      return [key, mapPathForEnvironment(value, environment, workspacePaths) ?? value];
    }),
  );
}

const PATH_VALUE_FLAGS = new Set(["--add-dir", "--cd", "-C", "--dir"]);

export function mapAgentArgsForEnvironment(
  args: string[],
  environment: ResolvedExecutionEnvironment,
  workspacePaths: Pick<ResolvedWorkspacePaths, "host_worktree_path" | "guest_worktree_path">,
): string[] {
  if (environment.kind !== "vm-ssh") {
    return args;
  }

  const mappedArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    const [flag, inlineValue] = arg.split("=", 2);
    if (!PATH_VALUE_FLAGS.has(flag)) {
      mappedArgs.push(arg);
      continue;
    }

    if (inlineValue !== undefined) {
      const mappedInlineValue =
        mapPathForEnvironment(inlineValue, environment, workspacePaths) ?? inlineValue;
      mappedArgs.push(`${flag}=${mappedInlineValue}`);
      continue;
    }

    const value = args[index + 1];
    mappedArgs.push(arg);
    if (value === undefined) {
      continue;
    }

    const mappedValue =
      mapPathForEnvironment(value, environment, workspacePaths) ?? value;
    mappedArgs.push(mappedValue);
    index += 1;
  }

  return mappedArgs;
}

function buildVmSshTarget(config: VmSshExecutionEnvironmentConfig): string {
  if (config.ssh_user === undefined) {
    return config.ssh_host;
  }

  return `${config.ssh_user}@${config.ssh_host}`;
}

function buildMiseBootstrapSnippet(): string {
  return [
    "if [ -f .mise.toml ] || [ -f mise.toml ] || [ -f .tool-versions ]; then",
    "  if command -v mise >/dev/null 2>&1; then",
    "    mise trust -y >/dev/null 2>&1 || true;",
    "    mise install;",
    "  fi;",
    "fi",
  ].join(" ");
}

function buildUserLocalPathSnippet(): string {
  return [
    'export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
  ].join(" ");
}

export function buildVmAgentStatePaths(
  workspacePaths: Pick<ResolvedWorkspacePaths, "host_worktree_path" | "guest_worktree_path">,
): VmAgentStatePaths {
  return {
    host_marker_path: buildVmAgentHostMarkerPath(
      workspacePaths.host_worktree_path,
    ),
    guest_marker_path: posix.join(
      workspacePaths.guest_worktree_path,
      ".pitch",
      "vm-agent-active",
    ),
  };
}

function buildVmAgentExecutionSnippet(
  remoteCommand: string,
  guestMarkerPath: string,
): string {
  const guestMarkerDir = posix.dirname(guestMarkerPath);

  return [
    `mkdir -p -- ${shellEscape(guestMarkerDir)}`,
    `cleanup() { rm -f -- ${shellEscape(guestMarkerPath)}; }`,
    "trap cleanup EXIT INT TERM",
    `: > ${shellEscape(guestMarkerPath)}`,
    `${remoteCommand}`,
    "status=$?",
    "cleanup",
    "trap - EXIT INT TERM",
    'printf "\\n[pitch] Agent exited (status %s). Staying in guest shell.\\n" "$status"',
  ].join("; ");
}

export interface VmSshCommandInput {
  environment: VmSshExecutionEnvironmentConfig;
  workspace_paths: Pick<ResolvedWorkspacePaths, "host_worktree_path" | "guest_worktree_path">;
  agent_command: string[];
  agent_env: Record<string, string>;
  run_bootstrap: boolean;
}

export function buildVmSshCommand(
  input: VmSshCommandInput,
): {
  command: string[];
  reuse_command: string;
  host_marker_path: string;
  pane_process_name: string;
} {
  const sshTarget = buildVmSshTarget(input.environment);
  const statePaths = buildVmAgentStatePaths(input.workspace_paths);
  const remoteEnv = Object.entries(input.agent_env).map(([key, value]) =>
    formatEnvAssignment(key, value),
  );
  const remoteCommand = [
    ...(remoteEnv.length === 0 ? [] : ["env", ...remoteEnv]),
    ...input.agent_command.map((part) => shellEscape(part)),
  ].join(" ");

  const bootstrapSnippet =
    input.run_bootstrap && input.environment.bootstrap.mise_install
      ? `${buildMiseBootstrapSnippet()} && `
      : "";
  const remoteAgentScript =
    `${buildUserLocalPathSnippet()} && ` +
    `cd -- ${shellEscape(input.workspace_paths.guest_worktree_path)} && ` +
    `${bootstrapSnippet}${buildVmAgentExecutionSnippet(remoteCommand, statePaths.guest_marker_path)}`;
  const remoteSessionScript = `${remoteAgentScript}; exec bash -li`;

  const command = ["ssh", "-tt"];
  if (input.environment.ssh_identity_file !== undefined) {
    command.push("-i", input.environment.ssh_identity_file);
  }
  if (input.environment.ssh_port !== undefined) {
    command.push("-p", String(input.environment.ssh_port));
  }
  command.push(
    ...input.environment.ssh_options,
    sshTarget,
    `bash -lc ${shellEscape(remoteSessionScript)}`,
  );

  return {
    command,
    reuse_command: remoteAgentScript,
    host_marker_path: statePaths.host_marker_path,
    pane_process_name: "ssh",
  };
}

export function deriveAgentPaneProcess(
  agentType: string,
  agentRuntime: AgentRuntime,
  environmentKind: ExecutionEnvironmentKind,
): string {
  if (environmentKind === "vm-ssh") {
    return "ssh";
  }

  if (agentRuntime === "docker") {
    return "agent-en-place";
  }

  return agentType;
}

export function isVmSshEnvironment(
  environment: ResolvedExecutionEnvironment,
): environment is ResolvedExecutionEnvironment & {
  config: VmSshExecutionEnvironmentConfig;
  kind: "vm-ssh";
} {
  return environment.kind === "vm-ssh" && environment.config !== undefined;
}

export function resolveWorkspaceEnvironmentName(
  repoConfig: RepoConfig,
  config: PitchConfig,
  environmentName: string | null | undefined,
): string | undefined {
  return environmentName ?? repoConfig.default_environment ?? config.defaults.environment;
}
