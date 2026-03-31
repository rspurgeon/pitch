import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  RepoConfig,
  VmSshExecutionEnvironmentConfig,
} from "./config.js";
import {
  mapPathForEnvironment,
  type ResolvedExecutionEnvironment,
  type ResolvedWorkspacePaths,
} from "./execution-environment.js";
import { shellEscape } from "./shell.js";

const execFileAsync = promisify(execFile);

interface ClaudeTrustState {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
  [key: string]: unknown;
}

export interface EnsureClaudeTrustedPathsInput {
  environment: ResolvedExecutionEnvironment;
  workspace_paths: ResolvedWorkspacePaths;
  repo: Pick<RepoConfig, "main_worktree" | "worktree_base">;
  claude_config_dir?: string;
}

interface ClaudeProjectState {
  hasTrustDialogAccepted?: boolean;
  [key: string]: unknown;
}

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function normalizeTrustedPaths(paths: string[]): string[] {
  const uniquePaths = new Set<string>();

  for (const path of paths) {
    uniquePaths.add(normalize(resolve(expandHomePath(path))));
  }

  return [...uniquePaths];
}

function normalizeGuestTrustedPaths(paths: string[]): string[] {
  const uniquePaths = new Set<string>();

  for (const path of paths) {
    uniquePaths.add(normalize(path));
  }

  return [...uniquePaths];
}

function resolveClaudeConfigDir(path: string | undefined): string {
  return normalize(resolve(expandHomePath(path ?? "~/.claude")));
}

function resolveGuestClaudeConfigDir(path: string | undefined): string {
  return normalize(path ?? "~/.claude");
}

function buildTrustedPaths(
  input: EnsureClaudeTrustedPathsInput,
): string[] {
  const hostPaths = [
    input.repo.main_worktree,
    input.repo.worktree_base,
  ];

  if (input.environment.kind !== "vm-ssh") {
    return normalizeTrustedPaths(hostPaths);
  }

  const mappedPaths = hostPaths.map((path) =>
    mapPathForEnvironment(path, input.environment, input.workspace_paths) ??
    input.workspace_paths.guest_worktree_path,
  );

  return normalizeGuestTrustedPaths(mappedPaths);
}

function isTrustOnlyProjectEntry(entry: ClaudeProjectState | undefined): boolean {
  if (entry === undefined) {
    return false;
  }

  const keys = Object.keys(entry);
  return keys.length === 0 ||
    (keys.length === 1 && entry.hasTrustDialogAccepted === true);
}

function isSameOrDescendantPath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function pruneRedundantProjectTrust(
  projects: Record<string, ClaudeProjectState>,
): Record<string, ClaudeProjectState> {
  const trustedParents = Object.entries(projects)
    .filter(([, entry]) => entry.hasTrustDialogAccepted === true)
    .map(([path]) => normalize(path))
    .sort((left, right) => left.length - right.length);

  const pruned = { ...projects };

  for (const [path, entry] of Object.entries(projects)) {
    if (!isTrustOnlyProjectEntry(entry)) {
      continue;
    }

    const normalizedPath = normalize(path);
    const hasTrustedAncestor = trustedParents.some((candidate) =>
      candidate !== normalizedPath &&
      isSameOrDescendantPath(normalizedPath, candidate),
    );

    if (hasTrustedAncestor) {
      delete pruned[path];
    }
  }

  return pruned;
}

async function updateClaudeTrustFile(
  claudeConfigDir: string,
  trustedPaths: string[],
): Promise<void> {
  await mkdir(claudeConfigDir, { recursive: true });
  const trustFilePath = join(claudeConfigDir, ".claude.json");

  let state: ClaudeTrustState = {};
  try {
    const contents = await readFile(trustFilePath, "utf8");
    state = JSON.parse(contents) as ClaudeTrustState;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const projects = state.projects ?? {};
  for (const trustedPath of trustedPaths) {
    projects[trustedPath] = {
      ...(projects[trustedPath] ?? {}),
      hasTrustDialogAccepted: true,
    };
  }
  state.projects = pruneRedundantProjectTrust(projects);

  await mkdir(dirname(trustFilePath), { recursive: true });
  await writeFile(trustFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function buildVmTrustCommand(
  claudeConfigDir: string,
  trustedPaths: string[],
): string {
  const pythonScript = [
    "import json, os, sys",
    "config_dir = os.path.abspath(os.path.expanduser(sys.argv[1]))",
    "os.makedirs(config_dir, exist_ok=True)",
    "state_path = os.path.join(config_dir, '.claude.json')",
    "state = {}",
    "if os.path.exists(state_path):",
    "    with open(state_path, 'r', encoding='utf-8') as fh:",
    "        state = json.load(fh)",
    "projects = state.setdefault('projects', {})",
    "for path in sys.argv[2:] :",
    "    trusted = os.path.abspath(os.path.expanduser(path))",
    "    entry = projects.setdefault(trusted, {})",
    "    entry['hasTrustDialogAccepted'] = True",
    "trusted_parents = sorted([os.path.normpath(p) for p, e in projects.items() if isinstance(e, dict) and e.get('hasTrustDialogAccepted')], key=len)",
    "for path in list(projects.keys()):",
    "    entry = projects.get(path)",
    "    if not isinstance(entry, dict):",
    "        continue",
    "    keys = list(entry.keys())",
    "    trust_only = len(keys) == 0 or (len(keys) == 1 and entry.get('hasTrustDialogAccepted') is True)",
    "    if not trust_only:",
    "        continue",
    "    normalized = os.path.normpath(path)",
    "    redundant = any(parent != normalized and (normalized == parent or normalized.startswith(parent + os.sep)) for parent in trusted_parents)",
    "    if redundant:",
    "        projects.pop(path, None)",
    "with open(state_path, 'w', encoding='utf-8') as fh:",
    "    json.dump(state, fh, indent=2)",
    "    fh.write('\\n')",
  ].join("\n");

  const argv = [
    "python3",
    "-c",
    pythonScript,
    claudeConfigDir,
    ...trustedPaths,
  ].map((part) => shellEscape(part));

  return argv.join(" ");
}

async function updateVmClaudeTrustFile(
  vmConfig: VmSshExecutionEnvironmentConfig,
  claudeConfigDir: string,
  trustedPaths: string[],
): Promise<void> {
  const sshTarget = vmConfig.ssh_user === undefined
    ? vmConfig.ssh_host
    : `${vmConfig.ssh_user}@${vmConfig.ssh_host}`;

  const command = ["ssh", "-o", "BatchMode=yes"];
  if (vmConfig.ssh_identity_file !== undefined) {
    command.push("-i", vmConfig.ssh_identity_file);
  }
  if (vmConfig.ssh_port !== undefined) {
    command.push("-p", String(vmConfig.ssh_port));
  }

  command.push(
    ...vmConfig.ssh_options,
    sshTarget,
    `bash -lc ${shellEscape(buildVmTrustCommand(claudeConfigDir, trustedPaths))}`,
  );

  await execFileAsync(command[0]!, command.slice(1));
}

export async function ensureClaudeTrustedPaths(
  input: EnsureClaudeTrustedPathsInput,
): Promise<void> {
  if (input.environment.kind !== "vm-ssh") {
    const claudeConfigDir = resolveClaudeConfigDir(input.claude_config_dir);
    const trustedPaths = buildTrustedPaths(input);
    await updateClaudeTrustFile(claudeConfigDir, trustedPaths);
    return;
  }

  const vmConfig = input.environment.config as VmSshExecutionEnvironmentConfig | undefined;
  if (vmConfig === undefined) {
    throw new Error("Missing vm-ssh execution environment config");
  }

  const claudeConfigDir = resolveGuestClaudeConfigDir(input.claude_config_dir);
  const trustedPaths = buildTrustedPaths(input);
  await updateVmClaudeTrustFile(vmConfig, claudeConfigDir, trustedPaths);
}
