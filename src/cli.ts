import { stdout as defaultStdout, stderr as defaultStderr } from "node:process";
import { closeWorkspace, type CloseWorkspaceInput } from "./close-workspace.js";
import { loadConfig } from "./config.js";
import { createWorkspace, type CreateWorkspaceInput } from "./create-workspace.js";
import { resumeWorkspace, type ResumeWorkspaceInput } from "./resume-workspace.js";
import {
  getWorkspace,
  listWorkspaces,
  type GetWorkspaceInput,
  type ListWorkspacesInput,
  type WorkspaceSummary,
} from "./workspace-query.js";
import type { WorkspaceRecord } from "./workspace-state.js";

type CliVerb =
  | "create"
  | "list"
  | "get"
  | "resume"
  | "close"
  | "delete"
  | "completion"
  | "__complete-workspaces";
type FlagValue = boolean | string;

interface ParsedArgs {
  verb: CliVerb | "help";
  flags: Map<string, FlagValue>;
  positionals: string[];
}

interface JsonCommandResult {
  command: Exclude<CliVerb, "completion" | "__complete-workspaces">;
  result: WorkspaceRecord | WorkspaceSummary[];
  warnings: string[];
}

export interface CliDependencies {
  loadConfig: typeof loadConfig;
  createWorkspace: typeof createWorkspace;
  listWorkspaces: typeof listWorkspaces;
  getWorkspace: typeof getWorkspace;
  resumeWorkspace: typeof resumeWorkspace;
  closeWorkspace: typeof closeWorkspace;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

const defaultDependencies: CliDependencies = {
  loadConfig,
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  resumeWorkspace,
  closeWorkspace,
  stdout: defaultStdout,
  stderr: defaultStderr,
};

const BOOLEAN_FLAGS = new Set([
  "help",
  "json",
  "skip-prompt",
  "keep-worktree",
]);

const STRING_FLAGS = new Set([
  "agent",
  "base-branch",
  "environment",
  "issue",
  "model",
  "name",
  "pr",
  "repo",
  "runtime",
  "slug",
  "status",
]);

function normalizeFlagName(flagName: string): string {
  return flagName.replaceAll("_", "-");
}

function setFlag(
  flags: Map<string, FlagValue>,
  flagName: string,
  value: FlagValue,
): void {
  flags.set(normalizeFlagName(flagName), value);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const rawFlag = token.slice(2);
    const equalsIndex = rawFlag.indexOf("=");
    const rawName = equalsIndex === -1 ? rawFlag : rawFlag.slice(0, equalsIndex);
    const rawInlineValue =
      equalsIndex === -1 ? undefined : rawFlag.slice(equalsIndex + 1);
    const flagName = normalizeFlagName(rawName);

    if (!BOOLEAN_FLAGS.has(flagName) && !STRING_FLAGS.has(flagName)) {
      throw new Error(`Unknown option: --${rawName}`);
    }

    if (BOOLEAN_FLAGS.has(flagName)) {
      if (rawInlineValue !== undefined) {
        throw new Error(`Option --${rawName} does not take a value.`);
      }

      setFlag(flags, flagName, true);
      continue;
    }

    if (rawInlineValue !== undefined) {
      setFlag(flags, flagName, rawInlineValue);
      continue;
    }

    const nextToken = argv[index + 1];
    if (nextToken === undefined) {
      throw new Error(`Missing value for --${rawName}`);
    }
    if (nextToken.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}`);
    }

    setFlag(flags, flagName, nextToken);
    index += 1;
  }

  if (flags.get("help") === true) {
    return {
      verb: "help",
      flags,
      positionals,
    };
  }

  if (positionals.length === 0) {
    return {
      verb: "help",
      flags,
      positionals,
    };
  }

  const maybeAlias = positionals[0];
  const remaining = [...positionals];
  if (maybeAlias === "workspace") {
    remaining.shift();
    if (remaining.length === 0) {
      return {
        verb: "help",
        flags,
        positionals: [],
      };
    }
  }

  const verbToken = maybeAlias === "workspace" ? remaining.shift() : remaining.shift();
  if (verbToken === undefined) {
    return {
      verb: "help",
      flags,
      positionals: remaining,
    };
  }

  if (
    verbToken !== "create" &&
    verbToken !== "list" &&
        verbToken !== "get" &&
        verbToken !== "resume" &&
        verbToken !== "close" &&
        verbToken !== "delete" &&
        verbToken !== "completion" &&
        verbToken !== "__complete-workspaces"
  ) {
    throw new Error(`Unknown command: ${verbToken}`);
  }

  return {
    verb: verbToken,
    flags,
    positionals: remaining,
  };
}

function readStringFlag(
  flags: Map<string, FlagValue>,
  flagName: string,
): string | undefined {
  const value = flags.get(flagName);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Option --${flagName} requires a value.`);
  }
  return value;
}

function readNumberFlag(
  flags: Map<string, FlagValue>,
  flagName: string,
): number | undefined {
  const value = readStringFlag(flags, flagName);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid numeric value for --${flagName}: ${value}`);
  }

  return parsed;
}

function readBooleanFlag(
  flags: Map<string, FlagValue>,
  flagName: string,
): boolean | undefined {
  const value = flags.get(flagName);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(
      `Option --${flagName} does not accept a string value: ${value}`,
    );
  }
  return value;
}

function ensureNoExtraPositionals(
  positionals: string[],
  verb: CliVerb,
): void {
  if (positionals.length > 0) {
    throw new Error(
      `Unexpected positional arguments for ${verb}: ${positionals.join(" ")}`,
    );
  }
}

function resolveWorkspaceName(
  flags: Map<string, FlagValue>,
  positionals: string[],
): string {
  const flagName = readStringFlag(flags, "name");
  const positionalName = positionals.at(0);
  if (positionals.length > 1) {
    throw new Error(
      `Unexpected positional arguments: ${positionals.slice(1).join(" ")}`,
    );
  }

  if (flagName !== undefined && positionalName !== undefined && flagName !== positionalName) {
    throw new Error(
      `Conflicting workspace names: ${positionalName} and --name ${flagName}`,
    );
  }

  const name = flagName ?? positionalName;
  if (name === undefined) {
    throw new Error("Missing workspace name.");
  }

  return name;
}

function buildCreateInput(flags: Map<string, FlagValue>): CreateWorkspaceInput {
  return {
    repo: readStringFlag(flags, "repo"),
    issue: readNumberFlag(flags, "issue"),
    pr: readNumberFlag(flags, "pr"),
    slug: readStringFlag(flags, "slug") ?? "",
    base_branch: readStringFlag(flags, "base-branch"),
    agent: readStringFlag(flags, "agent"),
    environment: readStringFlag(flags, "environment"),
    skip_prompt: readBooleanFlag(flags, "skip-prompt"),
    runtime:
      readStringFlag(flags, "runtime") === undefined
        ? undefined
        : (readStringFlag(flags, "runtime") as "native" | "docker"),
    model: readStringFlag(flags, "model"),
  };
}

function buildListInput(flags: Map<string, FlagValue>): ListWorkspacesInput {
  return {
    repo: readStringFlag(flags, "repo"),
    status:
      readStringFlag(flags, "status") === undefined
        ? undefined
        : (readStringFlag(flags, "status") as "active" | "closed" | "all"),
  };
}

function buildGetInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): GetWorkspaceInput {
  return {
    name: resolveWorkspaceName(flags, positionals),
  };
}

function buildResumeInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): ResumeWorkspaceInput {
  return {
    name: resolveWorkspaceName(flags, positionals),
    agent: readStringFlag(flags, "agent"),
    environment: readStringFlag(flags, "environment"),
  };
}

function buildCloseInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): CloseWorkspaceInput {
  const keepWorktree = readBooleanFlag(flags, "keep-worktree");
  return {
    name: resolveWorkspaceName(flags, positionals),
    cleanup_worktree:
      keepWorktree === true ? false : undefined,
  };
}

function formatWorkspaceSummary(workspace: WorkspaceRecord): string {
  const lines = [
    `name: ${workspace.name}`,
    `repo: ${workspace.repo}`,
    `status: ${workspace.status}`,
    `source: ${workspace.source_kind} #${workspace.source_number}`,
    `branch: ${workspace.branch}`,
    `agent: ${workspace.agent_name} (${workspace.agent_type}, ${workspace.agent_runtime})`,
    `environment: ${workspace.environment_name ?? workspace.environment_kind ?? "host"}`,
    `worktree: ${workspace.worktree_path}`,
    `tmux: ${workspace.tmux_session}:${workspace.tmux_window}`,
  ];

  return `${lines.join("\n")}\n`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, columnIndex) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[columnIndex]?.length ?? 0),
    ),
  );

  const renderRow = (row: string[]) =>
    row
      .map((value, columnIndex) => value.padEnd(widths[columnIndex]))
      .join("  ")
      .trimEnd();

  return `${renderRow(headers)}\n${rows.map(renderRow).join("\n")}\n`;
}

function formatWorkspaceList(workspaces: WorkspaceSummary[]): string {
  if (workspaces.length === 0) {
    return "No workspaces found.\n";
  }

  return renderTable(
    ["Name", "Repo", "Source", "Status", "Agent", "Tmux"],
    workspaces.map((workspace) => [
      workspace.name,
      workspace.repo,
      `${workspace.source_kind}#${workspace.source_number}`,
      workspace.status,
      workspace.agent_name,
      `${workspace.tmux_session}:${workspace.tmux_window}`,
    ]),
  );
}

function buildHelpText(): string {
  return [
    "Usage:",
    "  pitch create (--issue N | --pr N) --slug SLUG [options]",
    "  pitch list [--repo REPO] [--status active|closed|all]",
    "  pitch get <name>",
    "  pitch resume <name> [--agent AGENT] [--environment ENV]",
    "  pitch close <name> [--keep-worktree]",
    "  pitch delete <name> [--keep-worktree]",
    "  pitch completion zsh",
    "  pitch workspace <command> ...",
    "",
    "Options:",
    "  --repo REPO",
    "  --issue N",
    "  --pr N",
    "  --slug SLUG",
    "  --base-branch BRANCH",
    "  --agent AGENT",
    "  --environment ENV",
    "  --runtime native|docker",
    "  --model MODEL",
    "  --skip-prompt",
    "  --status active|closed|all",
    "  --name NAME",
    "  --keep-worktree",
    "  --json",
    "  --help",
    "",
    "The `workspace` noun is accepted as an alias for compatibility.",
  ].join("\n");
}

function buildZshCompletionScript(): string {
  return [
    "#compdef pitch",
    "",
    "_pitch_workspaces() {",
    "  local -a workspaces",
    "  workspaces=(\"${(@f)$(pitch __complete-workspaces 2>/dev/null)}\")",
    "  (( ${#workspaces[@]} )) || return 1",
    "  _describe -t workspaces 'workspace' workspaces",
    "}",
    "",
    "_pitch_complete_workspace_target() {",
    "  local command_index=\"$1\"",
    "  local workspace_index=$(( command_index + 1 ))",
    "",
    "  if (( CURRENT == workspace_index )); then",
    "    if [[ -z \"${words[CURRENT]}\" || \"${words[CURRENT]}\" != -* ]]; then",
    "      _pitch_workspaces && return 0",
    "    fi",
    "  fi",
    "",
    "  if (( CURRENT > 1 )) && [[ \"${words[CURRENT-1]}\" == \"--name\" ]]; then",
    "    _pitch_workspaces && return 0",
    "  fi",
    "",
    "  return 1",
    "}",
    "",
    "_pitch_dispatch() {",
    "  local cmd=\"$1\"",
    "  local command_index=\"$2\"",
    "  case \"$cmd\" in",
    "    create)",
    "      _arguments -s -S \\",
    "        '--repo[GitHub org/repo]:repo:' \\",
    "        '--issue[Issue number]:issue:' \\",
    "        '--pr[Pull request number]:pr:' \\",
    "        '--slug[Workspace slug]:slug:' \\",
    "        '--base-branch[Base branch]:branch:' \\",
    "        '--agent[Configured agent]:agent:' \\",
    "        '--environment[Execution environment]:environment:' \\",
    "        '--runtime[Agent runtime]:runtime:(native docker)' \\",
    "        '--model[Model override]:model:' \\",
    "        '--skip-prompt[Skip bootstrap prompt]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    list)",
    "      _arguments -s -S \\",
    "        '--repo[GitHub org/repo]:repo:' \\",
    "        '--status[Workspace status]:status:(active closed all)' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    get)",
    "      _pitch_complete_workspace_target \"$command_index\" && return",
    "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    resume)",
    "      _pitch_complete_workspace_target \"$command_index\" && return",
    "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--agent[Configured agent]:agent:' \\",
    "        '--environment[Execution environment]:environment:' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    close|delete)",
    "      _pitch_complete_workspace_target \"$command_index\" && return",
    "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--keep-worktree[Keep the worktree after closing]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    completion)",
    "      _arguments '1:shell:(zsh)'",
    "      ;;",
    "  esac",
    "}",
    "",
    "_pitch() {",
    "  if (( CURRENT == 2 )); then",
    "    _values 'pitch command' \\",
    "      'create[Create a workspace]' \\",
    "      'list[List workspaces]' \\",
    "      'get[Show a workspace]' \\",
    "      'resume[Resume a workspace]' \\",
    "      'close[Close a workspace]' \\",
    "      'delete[Delete a workspace]' \\",
    "      'completion[Generate shell completion]' \\",
    "      'workspace[Compatibility alias for workspace lifecycle commands]'",
    "    return",
    "  fi",
    "",
    "  if [[ \"${words[2]}\" == \"workspace\" ]]; then",
    "    if (( CURRENT == 3 )); then",
    "      _values 'pitch workspace command' \\",
    "        'create[Create a workspace]' \\",
    "        'list[List workspaces]' \\",
    "        'get[Show a workspace]' \\",
    "        'resume[Resume a workspace]' \\",
    "        'close[Close a workspace]' \\",
    "        'delete[Delete a workspace]' \\",
    "        'completion[Generate shell completion]'",
    "      return",
    "    fi",
    "    _pitch_dispatch \"${words[3]}\" 3",
    "    return",
    "  fi",
    "",
    "  _pitch_dispatch \"${words[2]}\" 2",
    "}",
    "",
    "_pitch \"$@\"",
  ].join("\n");
}

function writeWarnings(
  warnings: string[],
  dependencies: CliDependencies,
): void {
  for (const warning of warnings) {
    dependencies.stderr.write(`Warning: ${warning}\n`);
  }
}

async function executeCommand(
  parsed: ParsedArgs,
  dependencies: CliDependencies,
): Promise<JsonCommandResult | null> {
  switch (parsed.verb) {
    case "help":
      return null;
    case "create": {
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      const config = await dependencies.loadConfig();
      const warnings: string[] = [];
      const result = await dependencies.createWorkspace(
        buildCreateInput(parsed.flags),
        config,
        {
          reportWarning: (warning) => warnings.push(warning),
        },
      );
      return {
        command: parsed.verb,
        result,
        warnings,
      };
    }
    case "list":
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      return {
        command: parsed.verb,
        result: await dependencies.listWorkspaces(buildListInput(parsed.flags)),
        warnings: [],
      };
    case "get":
      return {
        command: parsed.verb,
        result: await dependencies.getWorkspace(
          buildGetInput(parsed.flags, parsed.positionals),
        ),
        warnings: [],
      };
    case "resume": {
      const config = await dependencies.loadConfig();
      const warnings: string[] = [];
      const result = await dependencies.resumeWorkspace(
        buildResumeInput(parsed.flags, parsed.positionals),
        config,
        {
          reportWarning: (warning) => warnings.push(warning),
        },
      );
      return {
        command: parsed.verb,
        result,
        warnings,
      };
    }
    case "close":
    case "delete": {
      const config = await dependencies.loadConfig();
      return {
        command: "close",
        result: await dependencies.closeWorkspace(
          buildCloseInput(parsed.flags, parsed.positionals),
          config,
        ),
        warnings: [],
      };
    }
    case "completion":
    case "__complete-workspaces":
      return null;
  }
}

function isWorkspaceList(
  result: WorkspaceRecord | WorkspaceSummary[],
): result is WorkspaceSummary[] {
  return Array.isArray(result);
}

function writeHumanResult(
  commandResult: JsonCommandResult,
  dependencies: CliDependencies,
): void {
  if (isWorkspaceList(commandResult.result)) {
    dependencies.stdout.write(formatWorkspaceList(commandResult.result));
  } else {
    dependencies.stdout.write(formatWorkspaceSummary(commandResult.result));
  }

  writeWarnings(commandResult.warnings, dependencies);
}

function writeJsonResult(
  commandResult: JsonCommandResult,
  dependencies: CliDependencies,
): void {
  dependencies.stdout.write(`${JSON.stringify(commandResult, null, 2)}\n`);
}

export async function runCli(
  argv: string[],
  dependencyOverrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies: CliDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  try {
    const parsed = parseArgs(argv);
    if (parsed.verb === "help") {
      dependencies.stdout.write(`${buildHelpText()}\n`);
      return 0;
    }

    if (parsed.verb === "completion") {
      if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "zsh") {
        throw new Error("Usage: pitch completion zsh");
      }
      dependencies.stdout.write(`${buildZshCompletionScript()}\n`);
      return 0;
    }

    if (parsed.verb === "__complete-workspaces") {
      const workspaces = await dependencies.listWorkspaces({ status: "all" });
      if (workspaces.length > 0) {
        dependencies.stdout.write(
          `${workspaces.map((workspace) => workspace.name).join("\n")}\n`,
        );
      }
      return 0;
    }

    const commandResult = await executeCommand(parsed, dependencies);
    if (commandResult === null) {
      dependencies.stdout.write(`${buildHelpText()}\n`);
      return 0;
    }

    if (readBooleanFlag(parsed.flags, "json") === true) {
      writeJsonResult(commandResult, dependencies);
    } else {
      writeHumanResult(commandResult, dependencies);
    }

    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr.write(`pitch: ${message}\n`);
    return 1;
  }
}
