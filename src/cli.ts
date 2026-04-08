import { createInterface } from "node:readline/promises";
import {
  stdin as defaultStdin,
  stdout as defaultStdout,
  stderr as defaultStderr,
} from "node:process";
import {
  buildAgentShortcutEntries,
  getAgentsView,
  jumpToAgentSession,
  type AgentsView,
} from "./agents.js";
import {
  getAgentStatusSnapshot,
  markAgentSessionError,
  type AgentStatusSnapshot,
  type MarkAgentErrorInput,
} from "./agent-status.js";
import {
  closeWorkspace,
  deleteWorkspace,
  type CloseWorkspaceInput,
  type DeleteWorkspaceInput,
} from "./close-workspace.js";
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
import { renderStatusRight, type StatusRightInput } from "./status-right.js";
import { shellEscape } from "./shell.js";
import { displayTmuxMenu } from "./tmux.js";

type CliVerb =
  | "create"
  | "agents"
  | "agents-popup"
  | "jump"
  | "agent-status"
  | "agent-error"
  | "list"
  | "get"
  | "resume"
  | "close"
  | "delete"
  | "status-right"
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
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | AgentStatusSnapshot
    | AgentsView
    | string;
  warnings: string[];
}

export interface CliDependencies {
  getAgentsView: typeof getAgentsView;
  jumpToAgentSession: typeof jumpToAgentSession;
  displayTmuxMenu: typeof displayTmuxMenu;
  getAgentStatusSnapshot: typeof getAgentStatusSnapshot;
  markAgentSessionError: typeof markAgentSessionError;
  loadConfig: typeof loadConfig;
  createWorkspace: typeof createWorkspace;
  listWorkspaces: typeof listWorkspaces;
  getWorkspace: typeof getWorkspace;
  resumeWorkspace: typeof resumeWorkspace;
  closeWorkspace: typeof closeWorkspace;
  deleteWorkspace: typeof deleteWorkspace;
  renderStatusRight: typeof renderStatusRight;
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

const defaultDependencies: CliDependencies = {
  getAgentsView,
  jumpToAgentSession,
  displayTmuxMenu,
  getAgentStatusSnapshot,
  markAgentSessionError,
  loadConfig,
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  resumeWorkspace,
  closeWorkspace,
  deleteWorkspace,
  renderStatusRight,
  stdin: defaultStdin,
  stdout: defaultStdout,
  stderr: defaultStderr,
};

const BOOLEAN_FLAGS = new Set([
  "delete-branch-if-empty",
  "help",
  "json",
  "pick",
  "skip-prompt",
  "force",
  "sync",
]);

const STRING_FLAGS = new Set([
  "agent",
  "agent-type",
  "base-branch",
  "branch",
  "environment",
  "cwd",
  "issue",
  "model",
  "name",
  "pr",
  "repo",
  "message",
  "separator",
  "session-id",
  "slug",
  "status",
  "transcript-path",
  "tty",
  "tmux-session",
  "tmux-window",
]);

const SHORT_FLAG_ALIASES = new Map<string, string>([
  ["d", "delete-branch-if-empty"],
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

function hasImplicitCreateFlags(flags: Map<string, FlagValue>): boolean {
  const hasIssue = typeof flags.get("issue") === "string";
  const hasPr = typeof flags.get("pr") === "string";
  const hasName = typeof flags.get("name") === "string";

  return hasIssue || hasPr || hasName;
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

    if (token.startsWith("-") && !token.startsWith("--")) {
      const shortFlag = token.slice(1);
      if (shortFlag.length !== 1 || !SHORT_FLAG_ALIASES.has(shortFlag)) {
        throw new Error(`Unknown option: ${token}`);
      }

      setFlag(flags, SHORT_FLAG_ALIASES.get(shortFlag)!, true);
      continue;
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
    if (hasImplicitCreateFlags(flags)) {
      return {
        verb: "create",
        flags,
        positionals,
      };
    }

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
      if (hasImplicitCreateFlags(flags)) {
        return {
          verb: "create",
          flags,
          positionals: [],
        };
      }

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
    verbToken !== "agents" &&
    verbToken !== "agents-popup" &&
    verbToken !== "jump" &&
    verbToken !== "agent-status" &&
    verbToken !== "agent-error" &&
    verbToken !== "list" &&
        verbToken !== "get" &&
        verbToken !== "resume" &&
        verbToken !== "close" &&
        verbToken !== "delete" &&
        verbToken !== "status-right" &&
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
    name: readStringFlag(flags, "name"),
    slug: readStringFlag(flags, "slug"),
    branch: readStringFlag(flags, "branch"),
    base_branch: readStringFlag(flags, "base-branch"),
    agent: readStringFlag(flags, "agent"),
    environment: readStringFlag(flags, "environment"),
    skip_prompt: readBooleanFlag(flags, "skip-prompt"),
    model: readStringFlag(flags, "model"),
  };
}

function formatWorkspaceSource(
  workspace: Pick<WorkspaceRecord, "source_kind" | "source_number">,
): string {
  return workspace.source_number === null
    ? workspace.source_kind
    : `${workspace.source_kind} #${workspace.source_number}`;
}

function formatWorkspaceSourceCell(
  workspace: Pick<WorkspaceSummary, "source_kind" | "source_number">,
): string {
  return workspace.source_number === null
    ? workspace.source_kind
    : `${workspace.source_kind}#${workspace.source_number}`;
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
    sync: readBooleanFlag(flags, "sync"),
  };
}

function buildCloseInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): CloseWorkspaceInput {
  return {
    name: resolveWorkspaceName(flags, positionals),
  };
}

function buildDeleteInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): DeleteWorkspaceInput {
  return {
    name: resolveWorkspaceName(flags, positionals),
    force: readBooleanFlag(flags, "force"),
    delete_branch_if_empty: readBooleanFlag(flags, "delete-branch-if-empty"),
  };
}

function buildStatusRightInput(flags: Map<string, FlagValue>): StatusRightInput {
  return {
    separator: readStringFlag(flags, "separator"),
    tmuxSession: readStringFlag(flags, "tmux-session"),
    tmuxWindow: readStringFlag(flags, "tmux-window"),
  };
}

async function pickAgentSessionId(
  view: AgentsView,
  dependencies: CliDependencies,
): Promise<string> {
  const rl = createInterface({
    input: dependencies.stdin,
    output: dependencies.stdout as NodeJS.WritableStream,
  });

  try {
    const response = await rl.question("Jump to agent #: ");
    const choice = Number.parseInt(response.trim(), 10);

    if (!Number.isSafeInteger(choice) || choice < 1 || choice > view.agents.length) {
      throw new Error(`Invalid agent selection: ${response.trim() || "<empty>"}`);
    }

    return view.agents[choice - 1].session_id;
  } finally {
    rl.close();
  }
}

function buildAgentErrorInput(flags: Map<string, FlagValue>): MarkAgentErrorInput {
  const agentType = readStringFlag(flags, "agent-type");
  if (agentType !== "codex" && agentType !== "claude") {
    throw new Error("Option --agent-type must be one of: codex, claude");
  }

  const sessionId = readStringFlag(flags, "session-id");
  if (sessionId === undefined) {
    throw new Error("Missing required option --session-id.");
  }

  const message = readStringFlag(flags, "message");
  if (message === undefined || message.length === 0) {
    throw new Error("Missing required option --message.");
  }

  return {
    agent_type: agentType,
    session_id: sessionId,
    message,
    cwd: readStringFlag(flags, "cwd"),
    transcript_path: readStringFlag(flags, "transcript-path"),
    tty: readStringFlag(flags, "tty"),
  };
}

function buildJumpSessionId(positionals: string[]): string {
  const sessionId = positionals.at(0);
  if (positionals.length > 1) {
    throw new Error(
      `Unexpected positional arguments for jump: ${positionals.slice(1).join(" ")}`,
    );
  }
  if (sessionId === undefined) {
    throw new Error("Missing agent session id.");
  }
  return sessionId;
}

function formatWorkspaceSummary(workspace: WorkspaceRecord): string {
  const lines = [
    `name: ${workspace.name}`,
    `repo: ${workspace.repo}`,
    `status: ${workspace.status}`,
    `source: ${formatWorkspaceSource(workspace)}`,
    `branch: ${workspace.branch}`,
    `agent: ${workspace.agent_name} (${workspace.agent_type})`,
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
      formatWorkspaceSourceCell(workspace),
      workspace.status,
      workspace.agent_name,
      `${workspace.tmux_session}:${workspace.tmux_window}`,
    ]),
  );
}

function formatAgentStatusSnapshot(snapshot: AgentStatusSnapshot): string {
  const lines = [
    `summary: R:${snapshot.summary.counts.running} Q:${snapshot.summary.counts.question} I:${snapshot.summary.counts.idle} E:${snapshot.summary.counts.error}`,
    `active_sessions: ${snapshot.summary.active_sessions}`,
    `generated_at: ${snapshot.summary.generated_at}`,
  ];

  if (snapshot.sessions.length === 0) {
    lines.push("sessions: none");
    return `${lines.join("\n")}\n`;
  }

  lines.push("sessions:");
  for (const session of snapshot.sessions) {
    lines.push(
      `- ${session.agent_type} ${session.state} ${session.session_id} ${session.last_event} ${session.updated_at}`,
    );
    if (session.cwd !== undefined) {
      lines.push(`  cwd: ${session.cwd}`);
    }
    if (session.tty !== undefined) {
      lines.push(`  tty: ${session.tty}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatAgentsView(view: AgentsView): string {
  const lines = [
    `summary: R:${view.summary.counts.running} Q:${view.summary.counts.question} I:${view.summary.counts.idle} E:${view.summary.counts.error}`,
  ];

  if (view.agents.length === 0) {
    lines.push("agents: none");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    renderTable(
      ["#", "State", "Agent", "Session", "Tmux", "TTY", "Cwd"],
      view.agents.map((agent: AgentsView["agents"][number], index: number) => [
        String(index + 1),
        agent.state,
        agent.agent_type,
        agent.session_key,
        agent.tmux === undefined
          ? "-"
          : `${agent.tmux.session_name}:${agent.tmux.window_name}.${agent.tmux.pane_index}`,
        agent.tty ?? "-",
        agent.cwd ?? "-",
      ]),
    ).trimEnd(),
  );

  return `${lines.join("\n")}\n`;
}

function tmuxQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function buildAgentMenuCommand(entry: AgentsView["agents"][number]): string {
  if (entry.tmux === undefined) {
    throw new Error(`Cannot build tmux menu command for non-jumpable agent ${entry.session_id}`);
  }

  const target = `${entry.tmux.session_name}:${entry.tmux.window_name}`;
  const shellCommand = [
    `tmux switch-client -t ${shellEscape(target)}`,
    `tmux select-window -t ${shellEscape(target)}`,
    `tmux select-pane -t ${shellEscape(entry.tmux.pane_id)}`,
  ].join("; ");

  return `run-shell ${shellEscape(shellCommand)}`;
}

function buildAgentMenuLabel(entry: AgentsView["agents"][number]): string {
  const location =
    entry.tmux === undefined
      ? "-"
      : `${entry.tmux.session_name}:${entry.tmux.window_name}.${entry.tmux.pane_index}`;

  return [
    entry.state,
    entry.agent_type,
    entry.session_key,
    location,
    entry.cwd ?? "-",
  ].join("  ");
}

function buildHelpText(): string {
  return [
    "Usage:",
    "  pitch [create] (--issue N | --pr N) [--slug SLUG] [options]",
    "  pitch [create] --name NAME [--branch BRANCH] [options]",
    "  pitch agents [--pick]",
    "  pitch agents-popup",
    "  pitch jump <session-id-or-prefix>",
    "  pitch agent-status",
    "  pitch agent-error --agent-type TYPE --session-id ID --message TEXT",
    "  pitch list [--repo REPO] [--status active|closed|all]",
    "  pitch get <name>",
    "  pitch resume <name> [--agent AGENT] [--environment ENV] [--sync]",
    "  pitch close <name>",
    "  pitch delete <name> [--force] [-d|--delete-branch-if-empty]",
    "  pitch status-right [--separator TEXT]",
    "  pitch completion zsh",
    "  pitch workspace <command> ...",
    "",
    "Options:",
    "  --repo REPO",
    "  --separator TEXT",
    "  --issue N",
    "  --pr N",
    "  --name NAME",
    "  --slug SLUG",
    "  --branch BRANCH",
    "  --base-branch BRANCH",
    "  --agent AGENT",
    "  --agent-type codex|claude",
    "  --environment ENV",
    "  --cwd PATH",
    "  --transcript-path PATH",
    "  --tty TTY",
    "  --session-id ID",
    "  --message TEXT",
    "  --sync",
    "  --model MODEL",
    "  --skip-prompt",
    "  --force",
    "  -d, --delete-branch-if-empty",
    "  --pick",
    "  --status active|closed|all",
    "  --json",
    "  --help",
    "",
    "If --issue, --pr, or --name is provided without an explicit command,",
    "create is implied.",
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
    "        '--name[Ad hoc workspace name]:name:' \\",
    "        '--slug[Optional workspace slug suffix]:slug:' \\",
    "        '--branch[Ad hoc git branch name]:branch:' \\",
    "        '--base-branch[Base branch]:branch:' \\",
    "        '--agent[Configured agent]:agent:' \\",
    "        '--environment[Execution environment]:environment:' \\",
    "        '--model[Model override]:model:' \\",
    "        '--skip-prompt[Skip bootstrap prompt]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    agents)",
    "      _arguments -s -S \\",
    "        '--pick[Interactively choose and jump to a live agent]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    agents-popup)",
    "      _arguments -s -S \\",
    "        '--help[Show help]'",
    "      ;;",
    "    jump)",
    "      _arguments -s -S \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:session-id-or-prefix:'",
    "      ;;",
    "    agent-status)",
    "      _arguments -s -S \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    agent-error)",
    "      _arguments -s -S \\",
    "        '--agent-type[Agent type]:type:(codex claude)' \\",
    "        '--session-id[Agent session id]:session:' \\",
    "        '--message[Error message]:message:' \\",
    "        '--cwd[Working directory]:path:_files' \\",
    "        '--transcript-path[Transcript path]:path:_files' \\",
    "        '--tty[Terminal id]:tty:' \\",
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
    "        '--sync[Fast-forward PR workspaces to latest upstream head before resuming]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    close)",
      "      _pitch_complete_workspace_target \"$command_index\" && return",
      "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    delete)",
    "      _pitch_complete_workspace_target \"$command_index\" && return",
    "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--force[Delete even if the worktree has local changes]' \\",
    "        '-d[Delete the local branch only when it is unchanged from base and not pushed]' \\",
    "        '--delete-branch-if-empty[Delete the local branch only when it is unchanged from base and not pushed]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    status-right)",
    "      _arguments -s -S \\",
    "        '--separator[Append this suffix when agent status is present]:text:' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    completion)",
    "      _arguments '1:shell:(zsh)'",
    "      ;;",
    "  esac",
    "}",
    "",
    "_pitch() {",
    "  if [[ \"${words[2]}\" == --* ]]; then",
    "    _pitch_dispatch \"create\" 1",
    "    return",
    "  fi",
    "",
    "  if (( CURRENT == 2 )); then",
    "    _values 'pitch command' \\",
    "      'create[Create a workspace]' \\",
    "      'agents[List live agents with tmux targets]' \\",
    "      'agents-popup[Open a tmux agent menu with home-row keys]' \\",
    "      'jump[Focus the tmux pane for a live agent session]' \\",
    "      'agent-status[Inspect live agent hook state]' \\",
    "      'agent-error[Record an explicit agent error state]' \\",
    "      'list[List workspaces]' \\",
    "      'get[Show a workspace]' \\",
    "      'resume[Resume a workspace]' \\",
    "      'close[Close a workspace]' \\",
    "      'delete[Delete a workspace]' \\",
    "      'status-right[Render an agent status-right segment]' \\",
    "      'completion[Generate shell completion]' \\",
    "      'workspace[Compatibility alias for workspace lifecycle commands]'",
    "    return",
    "  fi",
    "",
    "  if [[ \"${words[2]}\" == \"workspace\" ]]; then",
    "    if [[ \"${words[3]}\" == --* ]]; then",
    "      _pitch_dispatch \"create\" 2",
    "      return",
    "    fi",
    "",
    "    if (( CURRENT == 3 )); then",
    "      _values 'pitch workspace command' \\",
    "        'create[Create a workspace]' \\",
    "        'agents[List live agents with tmux targets]' \\",
    "        'agents-popup[Open a tmux agent menu with home-row keys]' \\",
    "        'jump[Focus the tmux pane for a live agent session]' \\",
    "        'agent-status[Inspect live agent hook state]' \\",
    "        'agent-error[Record an explicit agent error state]' \\",
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
    case "agents":
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      if (readBooleanFlag(parsed.flags, "pick") === true) {
        if (readBooleanFlag(parsed.flags, "json") === true) {
          throw new Error("Cannot combine --pick with --json.");
        }

        const view = await dependencies.getAgentsView();
        if (view.agents.length === 0) {
          return {
            command: parsed.verb,
            result: "No live agents available.",
            warnings: [],
          };
        }

        dependencies.stdout.write(formatAgentsView(view));
        const selectedSessionId = await pickAgentSessionId(view, dependencies);
        const agent = await dependencies.jumpToAgentSession(selectedSessionId);
        return {
          command: parsed.verb,
          result: `Focused ${agent.agent_type} session ${agent.session_id}.`,
          warnings: [],
        };
      }
      return {
        command: parsed.verb,
        result: await dependencies.getAgentsView(),
        warnings: [],
      };
    case "agents-popup":
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      {
        const view = await dependencies.getAgentsView();
        const entries = buildAgentShortcutEntries(view.agents);

        if (entries.length === 0) {
          return {
            command: parsed.verb,
            result: "No jumpable agents available.",
            warnings: [],
          };
        }

        await dependencies.displayTmuxMenu({
          title: "Pitch Agents",
          x: "P",
          y: "P",
          items: entries.map((entry) => ({
            label: buildAgentMenuLabel(entry.agent),
            key: entry.key,
            command: buildAgentMenuCommand(entry.agent),
          })),
        });
        return {
          command: parsed.verb,
          result: "",
          warnings: [],
        };
      }
    case "jump": {
      const agent = await dependencies.jumpToAgentSession(
        buildJumpSessionId(parsed.positionals),
      );
      return {
        command: parsed.verb,
        result: `Focused ${agent.agent_type} session ${agent.session_id}.`,
        warnings: [],
      };
    }
    case "agent-status":
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      return {
        command: parsed.verb,
        result: await dependencies.getAgentStatusSnapshot(),
        warnings: [],
      };
    case "agent-error":
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      await dependencies.markAgentSessionError(
        buildAgentErrorInput(parsed.flags),
      );
      return {
        command: parsed.verb,
        result: "Recorded agent error state.",
        warnings: [],
      };
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
    case "close": {
      const config = await dependencies.loadConfig();
      const warnings: string[] = [];
      return {
        command: parsed.verb,
        result: await dependencies.closeWorkspace(
          buildCloseInput(parsed.flags, parsed.positionals),
          config,
          {
            reportWarning: (warning) => warnings.push(warning),
          },
        ),
        warnings,
      };
    }
    case "delete": {
      const config = await dependencies.loadConfig();
      const warnings: string[] = [];
      return {
        command: parsed.verb,
        result: await dependencies.deleteWorkspace(
          buildDeleteInput(parsed.flags, parsed.positionals),
          config,
          {
            reportWarning: (warning) => warnings.push(warning),
          },
        ),
        warnings,
      };
    }
    case "status-right":
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      return {
        command: parsed.verb,
        result: await dependencies.renderStatusRight(
          buildStatusRightInput(parsed.flags),
        ),
        warnings: [],
      };
    case "completion":
    case "__complete-workspaces":
      return null;
  }
}

function isWorkspaceList(
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | AgentStatusSnapshot
    | AgentsView
    | string,
): result is WorkspaceSummary[] {
  return Array.isArray(result);
}

function isAgentStatusSnapshot(
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | AgentStatusSnapshot
    | AgentsView
    | string,
): result is AgentStatusSnapshot {
  return (
    typeof result === "object" &&
    result !== null &&
    "summary" in result &&
    "sessions" in result
  );
}

function isAgentsView(
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | AgentStatusSnapshot
    | AgentsView
    | string,
): result is AgentsView {
  return (
    typeof result === "object" &&
    result !== null &&
    "agents" in result &&
    Array.isArray(result.agents)
  );
}

function writeHumanResult(
  commandResult: JsonCommandResult,
  dependencies: CliDependencies,
): void {
  if (typeof commandResult.result === "string") {
    if (commandResult.result.length > 0) {
      dependencies.stdout.write(`${commandResult.result}\n`);
    }
  } else if (isWorkspaceList(commandResult.result)) {
    dependencies.stdout.write(formatWorkspaceList(commandResult.result));
  } else if (isAgentsView(commandResult.result)) {
    dependencies.stdout.write(formatAgentsView(commandResult.result));
  } else if (isAgentStatusSnapshot(commandResult.result)) {
    dependencies.stdout.write(formatAgentStatusSnapshot(commandResult.result));
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
