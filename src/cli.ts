import { createInterface } from "node:readline/promises";
import { basename } from "node:path";
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
import { moveWorkspace, type MoveWorkspaceInput } from "./move-workspace.js";
import {
  renameWorkspace,
  type RenameWorkspaceInput,
} from "./rename-workspace.js";
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
import { renderWaybarStatus, watchWaybarStatus } from "./waybar-status.js";
import { runWorkspaceView } from "./workspace-view.js";
import { shellEscape } from "./shell.js";
import { displayTmuxMenu, listTmuxSessions } from "./tmux.js";

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
  | "restart"
  | "move"
  | "rename"
  | "close"
  | "delete"
  | "status-right"
  | "waybar-status"
  | "view"
  | "completion"
  | "__complete-workspaces"
  | "__complete-contexts"
  | "__complete-tmux-sessions";
type FlagValue = boolean | string | string[];

interface ParsedArgs {
  verb: CliVerb | "help";
  flags: Map<string, FlagValue>;
  positionals: string[];
}

interface WorkspaceSummaryGroup {
  key: WorkspaceListSortKey;
  value: string;
  label: string;
  workspaces: WorkspaceSummary[];
}

interface WorkspaceSummaryGroupedList {
  group_by: WorkspaceListSortKey;
  groups: WorkspaceSummaryGroup[];
}

interface JsonCommandResult {
  command: Exclude<
    CliVerb,
    | "completion"
    | "__complete-workspaces"
    | "__complete-contexts"
    | "__complete-tmux-sessions"
  >;
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | WorkspaceSummaryGroupedList
    | AgentStatusSnapshot
    | AgentsView
    | string;
  warnings: string[];
}

export interface CliDependencies {
  getAgentsView: typeof getAgentsView;
  jumpToAgentSession: typeof jumpToAgentSession;
  displayTmuxMenu: typeof displayTmuxMenu;
  listTmuxSessions: typeof listTmuxSessions;
  getAgentStatusSnapshot: typeof getAgentStatusSnapshot;
  markAgentSessionError: typeof markAgentSessionError;
  loadConfig: typeof loadConfig;
  createWorkspace: typeof createWorkspace;
  listWorkspaces: typeof listWorkspaces;
  getWorkspace: typeof getWorkspace;
  resumeWorkspace: typeof resumeWorkspace;
  moveWorkspace: typeof moveWorkspace;
  renameWorkspace: typeof renameWorkspace;
  closeWorkspace: typeof closeWorkspace;
  deleteWorkspace: typeof deleteWorkspace;
  renderStatusRight: typeof renderStatusRight;
  renderWaybarStatus: typeof renderWaybarStatus;
  watchWaybarStatus: typeof watchWaybarStatus;
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

const defaultDependencies: CliDependencies = {
  getAgentsView,
  jumpToAgentSession,
  displayTmuxMenu,
  listTmuxSessions,
  getAgentStatusSnapshot,
  markAgentSessionError,
  loadConfig,
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  resumeWorkspace,
  moveWorkspace,
  renameWorkspace,
  closeWorkspace,
  deleteWorkspace,
  renderStatusRight,
  renderWaybarStatus,
  watchWaybarStatus,
  stdin: defaultStdin,
  stdout: defaultStdout,
  stderr: defaultStderr,
};

const BOOLEAN_FLAGS = new Set([
  "delete-branch-if-empty",
  "exit-on-jump",
  "help",
  "json",
  "keep-open-on-jump",
  "pick",
  "skip-prompt",
  "force",
  "reset-session",
  "sync",
  "watch",
]);

const STRING_FLAGS = new Set([
  "additional-dir",
  "agent",
  "agent-type",
  "base-branch",
  "branch",
  "context",
  "environment",
  "group-by",
  "cwd",
  "issue",
  "message",
  "model",
  "name",
  "prompt",
  "pr",
  "repo",
  "separator",
  "session-id",
  "slug",
  "sort",
  "status",
  "transcript-path",
  "tty",
  "to",
  "tmux-session",
  "tmux-window",
]);

const REPEATABLE_STRING_FLAGS = new Set([
  "additional-dir",
]);

const SHORT_FLAG_ALIASES = new Map<string, string>([
  ["d", "delete-branch-if-empty"],
]);

function normalizeFlagName(flagName: string): string {
  const normalized = flagName.replaceAll("_", "-");
  return normalized === "add-dir" ? "additional-dir" : normalized;
}

function setFlag(
  flags: Map<string, FlagValue>,
  flagName: string,
  value: FlagValue,
): void {
  const normalizedName = normalizeFlagName(flagName);
  if (REPEATABLE_STRING_FLAGS.has(normalizedName)) {
    if (typeof value !== "string") {
      throw new Error(`Option --${normalizedName} requires a value.`);
    }

    const existing = flags.get(normalizedName);
    if (existing === undefined) {
      flags.set(normalizedName, [value]);
      return;
    }

    if (!Array.isArray(existing)) {
      throw new Error(`Option --${normalizedName} cannot be mixed with other values.`);
    }

    existing.push(value);
    return;
  }

  flags.set(normalizedName, value);
}

function hasImplicitCreateFlags(flags: Map<string, FlagValue>): boolean {
  const hasIssue = typeof flags.get("issue") === "string";
  const hasPr = typeof flags.get("pr") === "string";
  const hasName = typeof flags.get("name") === "string";

  return hasIssue || hasPr || hasName;
}

function isCliVerbToken(token: string): token is CliVerb {
  return (
    token === "create" ||
    token === "agents" ||
    token === "agents-popup" ||
    token === "jump" ||
    token === "agent-status" ||
    token === "agent-error" ||
    token === "list" ||
    token === "get" ||
    token === "resume" ||
    token === "restart" ||
    token === "move" ||
    token === "rename" ||
    token === "close" ||
    token === "delete" ||
    token === "status-right" ||
    token === "waybar-status" ||
    token === "view" ||
    token === "completion" ||
    token === "__complete-workspaces" ||
    token === "__complete-contexts" ||
    token === "__complete-tmux-sessions"
  );
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

    if (hasImplicitCreateFlags(flags) && !isCliVerbToken(remaining[0])) {
      return {
        verb: "create",
        flags,
        positionals: remaining,
      };
    }
  } else if (hasImplicitCreateFlags(flags) && !isCliVerbToken(remaining[0])) {
    return {
      verb: "create",
      flags,
      positionals: remaining,
    };
  }

  const verbToken = maybeAlias === "workspace" ? remaining.shift() : remaining.shift();
  if (verbToken === undefined) {
    return {
      verb: "help",
      flags,
      positionals: remaining,
    };
  }

  if (!isCliVerbToken(verbToken)) {
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
  const value = flags.get(normalizeFlagName(flagName));
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new Error(`Option --${flagName} accepts multiple values.`);
  }
  if (typeof value !== "string") {
    throw new Error(`Option --${flagName} requires a value.`);
  }
  return value;
}

function readStringListFlag(
  flags: Map<string, FlagValue>,
  flagName: string,
): string[] | undefined {
  const value = flags.get(normalizeFlagName(flagName));
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [value];
  }
  throw new Error(`Option --${flagName} requires a value.`);
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

function buildCreateInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): CreateWorkspaceInput {
  const additionalPaths = readStringListFlag(flags, "additional-dir");
  const issueValue = readStringFlag(flags, "issue");
  const prValue = readStringFlag(flags, "pr");
  const name = readStringFlag(flags, "name");
  const promptFlag = readStringFlag(flags, "prompt");
  const positionalPrompt =
    positionals.length === 0 ? undefined : positionals.join(" ");
  if (promptFlag !== undefined && positionalPrompt !== undefined) {
    throw new Error(
      "Use either --prompt TEXT or trailing prompt text, not both.",
    );
  }

  const prompt = promptFlag ?? positionalPrompt;
  const sourceSelectorCount = [
    issueValue !== undefined,
    prValue !== undefined,
    name !== undefined,
  ].filter(Boolean).length;

  if (sourceSelectorCount === 0) {
    throw new Error(
      "Create requires exactly one workspace source: --issue N, --pr N, or --name NAME.",
    );
  }

  if (sourceSelectorCount > 1) {
    if (name !== undefined && prValue !== undefined && issueValue === undefined) {
      throw new Error(
        `--name creates an ad hoc workspace and cannot be combined with --pr. Use --slug ${name} to create pr-${prValue}-${name}, or omit --pr to create an ad hoc workspace named ${name}.`,
      );
    }

    if (name !== undefined && issueValue !== undefined && prValue === undefined) {
      throw new Error(
        `--name creates an ad hoc workspace and cannot be combined with --issue. Use --slug ${name} to create gh-${issueValue}-${name}, or omit --issue to create an ad hoc workspace named ${name}.`,
      );
    }

    if (issueValue !== undefined && prValue !== undefined && name === undefined) {
      throw new Error("Choose either --issue N or --pr N, not both.");
    }

    throw new Error(
      "Create accepts exactly one workspace source: --issue N, --pr N, or --name NAME.",
    );
  }

  return {
    repo: readStringFlag(flags, "repo"),
    issue: readNumberFlag(flags, "issue"),
    pr: readNumberFlag(flags, "pr"),
    name,
    slug: readStringFlag(flags, "slug"),
    branch: readStringFlag(flags, "branch"),
    base_branch: readStringFlag(flags, "base-branch"),
    agent: readStringFlag(flags, "agent"),
    environment: readStringFlag(flags, "environment"),
    context: readStringFlag(flags, "context"),
    session_id: readStringFlag(flags, "session-id"),
    tmux_session: readStringFlag(flags, "tmux-session"),
    skip_prompt: readBooleanFlag(flags, "skip-prompt"),
    model: readStringFlag(flags, "model"),
    prompt,
    ...(additionalPaths === undefined ? {} : { additional_paths: additionalPaths }),
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

type WorkspaceListSortKey =
  | "agent"
  | "agent_name"
  | "agent_type"
  | "name"
  | "repo"
  | "source"
  | "source_kind"
  | "source_number"
  | "status"
  | "tmux"
  | "tmux_session"
  | "tmux_window";

const DEFAULT_WORKSPACE_LIST_SORT: WorkspaceListSortKey[] = ["status", "name"];
const WORKSPACE_LIST_SORT_KEY_VALUES: WorkspaceListSortKey[] = [
  "agent",
  "agent_name",
  "agent_type",
  "name",
  "repo",
  "source",
  "source_kind",
  "source_number",
  "status",
  "tmux",
  "tmux_session",
  "tmux_window",
];
const WORKSPACE_LIST_SORT_ERROR =
  `Option --sort expects comma-separated fields. Valid fields: ${WORKSPACE_LIST_SORT_KEY_VALUES.join(", ")}.`;

const WORKSPACE_STATUS_SORT_ORDER = new Map<WorkspaceSummary["status"], number>([
  ["active", 0],
  ["closed", 1],
]);

const WORKSPACE_LIST_SORT_KEYS = new Set<WorkspaceListSortKey>(
  WORKSPACE_LIST_SORT_KEY_VALUES,
);

function buildListSort(flags: Map<string, FlagValue>): WorkspaceListSortKey[] {
  const sort = readStringFlag(flags, "sort");
  if (sort === undefined) {
    return DEFAULT_WORKSPACE_LIST_SORT;
  }

  const keys = sort.split(",").map((key) => key.trim());
  if (
    keys.length === 0 ||
    keys.length > WORKSPACE_LIST_SORT_KEY_VALUES.length ||
    keys.some((key) => key.length === 0)
  ) {
    throw new Error(WORKSPACE_LIST_SORT_ERROR);
  }

  const parsedKeys: WorkspaceListSortKey[] = [];
  for (const key of keys) {
    if (!WORKSPACE_LIST_SORT_KEYS.has(key as WorkspaceListSortKey)) {
      throw new Error(WORKSPACE_LIST_SORT_ERROR);
    }

    parsedKeys.push(key as WorkspaceListSortKey);
  }

  if (new Set(parsedKeys).size !== parsedKeys.length) {
    throw new Error(WORKSPACE_LIST_SORT_ERROR);
  }

  return parsedKeys;
}

function buildListGroupBy(
  flags: Map<string, FlagValue>,
): WorkspaceListSortKey | undefined {
  const groupBy = readStringFlag(flags, "group-by");
  if (groupBy === undefined) {
    return undefined;
  }

  const key = groupBy.trim();
  if (
    key.length === 0 ||
    key.includes(",") ||
    !WORKSPACE_LIST_SORT_KEYS.has(key as WorkspaceListSortKey)
  ) {
    throw new Error(
      `Option --group-by expects one field. Valid fields: ${WORKSPACE_LIST_SORT_KEY_VALUES.join(", ")}.`,
    );
  }

  return key as WorkspaceListSortKey;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }

  return left - right;
}

function compareSourceSummaries(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
): number {
  return (
    compareStrings(left.source_kind, right.source_kind) ||
    compareNullableNumbers(left.source_number, right.source_number)
  );
}

function compareAgentSummaries(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
): number {
  return (
    compareStrings(left.agent_name, right.agent_name) ||
    compareStrings(left.agent_type, right.agent_type)
  );
}

function compareTmuxSummaries(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
): number {
  return (
    compareStrings(left.tmux_session, right.tmux_session) ||
    compareStrings(left.tmux_window, right.tmux_window)
  );
}

function compareWorkspaceSummaries(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
  sortKeys: WorkspaceListSortKey[],
): number {
  for (const key of sortKeys) {
    let comparison = 0;
    switch (key) {
      case "agent":
        comparison = compareAgentSummaries(left, right);
        break;
      case "agent_name":
      case "agent_type":
      case "name":
      case "repo":
      case "source_kind":
      case "tmux_session":
      case "tmux_window":
        comparison = compareStrings(left[key], right[key]);
        break;
      case "source":
        comparison = compareSourceSummaries(left, right);
        break;
      case "source_number":
        comparison = compareNullableNumbers(
          left.source_number,
          right.source_number,
        );
        break;
      case "status":
        comparison =
          WORKSPACE_STATUS_SORT_ORDER.get(left.status)! -
          WORKSPACE_STATUS_SORT_ORDER.get(right.status)!;
        break;
      case "tmux":
        comparison = compareTmuxSummaries(left, right);
        break;
    }

    if (comparison !== 0) {
      return comparison;
    }
  }

  return left.name.localeCompare(right.name);
}

function sortWorkspaceSummaries(
  workspaces: WorkspaceSummary[],
  sortKeys: WorkspaceListSortKey[],
): WorkspaceSummary[] {
  return [...workspaces].sort((left, right) =>
    compareWorkspaceSummaries(left, right, sortKeys),
  );
}

function getWorkspaceListFieldLabel(
  workspace: WorkspaceSummary,
  key: WorkspaceListSortKey,
): string {
  switch (key) {
    case "agent":
      return workspace.agent_name;
    case "agent_name":
    case "agent_type":
    case "name":
    case "repo":
    case "source_kind":
    case "status":
    case "tmux_session":
    case "tmux_window":
      return workspace[key];
    case "source":
      return formatWorkspaceSourceCell(workspace);
    case "source_number":
      return workspace.source_number === null
        ? "-"
        : String(workspace.source_number);
    case "tmux":
      return `${workspace.tmux_session}:${workspace.tmux_window}`;
  }
}

function groupWorkspaceSummaries(
  workspaces: WorkspaceSummary[],
  groupBy: WorkspaceListSortKey,
): WorkspaceSummaryGroupedList {
  const groupsByValue = new Map<
    string,
    {
      representative: WorkspaceSummary;
      group: WorkspaceSummaryGroup;
    }
  >();

  for (const workspace of workspaces) {
    const label = getWorkspaceListFieldLabel(workspace, groupBy);
    const existing = groupsByValue.get(label);
    if (existing !== undefined) {
      existing.group.workspaces.push(workspace);
      continue;
    }

    groupsByValue.set(label, {
      representative: workspace,
      group: {
        key: groupBy,
        value: label,
        label,
        workspaces: [workspace],
      },
    });
  }

  const groups = [...groupsByValue.values()]
    .sort((left, right) =>
      compareWorkspaceSummaries(left.representative, right.representative, [
        groupBy,
      ]),
    )
    .map((entry) => entry.group);

  return {
    group_by: groupBy,
    groups,
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
  const additionalPaths = readStringListFlag(flags, "additional-dir");
  return {
    name: resolveWorkspaceName(flags, positionals),
    agent: readStringFlag(flags, "agent"),
    environment: readStringFlag(flags, "environment"),
    context: readStringFlag(flags, "context"),
    session_id: readStringFlag(flags, "session-id"),
    tmux_session: readStringFlag(flags, "tmux-session"),
    reset_session: readBooleanFlag(flags, "reset-session"),
    restart_agent: undefined,
    sync: readBooleanFlag(flags, "sync"),
    ...(additionalPaths === undefined ? {} : { additional_paths: additionalPaths }),
  };
}

function buildRestartInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): ResumeWorkspaceInput {
  return {
    ...buildResumeInput(flags, positionals),
    restart_agent: true,
  };
}

function buildMoveInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): MoveWorkspaceInput {
  const toSession = readStringFlag(flags, "to");
  const tmuxSessionFlag = readStringFlag(flags, "tmux-session");
  if (
    toSession !== undefined &&
    tmuxSessionFlag !== undefined &&
    toSession !== tmuxSessionFlag
  ) {
    throw new Error(
      `Conflicting tmux sessions: --to ${toSession} and --tmux-session ${tmuxSessionFlag}`,
    );
  }

  const tmuxSession = toSession ?? tmuxSessionFlag;
  if (tmuxSession === undefined) {
    throw new Error("Missing required option --to.");
  }

  return {
    name: resolveWorkspaceName(flags, positionals),
    tmux_session: tmuxSession,
  };
}

function buildRenameInput(
  flags: Map<string, FlagValue>,
  positionals: string[],
): RenameWorkspaceInput {
  const flaggedName = readStringFlag(flags, "name");
  const name = flaggedName ?? positionals.at(0);
  const newName =
    flaggedName === undefined ? positionals.at(1) : positionals.at(0);
  const extraPositionals =
    flaggedName === undefined ? positionals.slice(2) : positionals.slice(1);

  if (extraPositionals.length > 0) {
    throw new Error(
      `Unexpected positional arguments for rename: ${extraPositionals.join(" ")}`,
    );
  }
  if (name === undefined) {
    throw new Error("Missing workspace name.");
  }
  if (newName === undefined) {
    throw new Error("Missing new workspace name.");
  }

  return {
    name,
    new_name: newName,
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

function buildViewInput(flags: Map<string, FlagValue>): { exit_on_jump: boolean } {
  const exitOnJump = readBooleanFlag(flags, "exit-on-jump");
  const keepOpenOnJump = readBooleanFlag(flags, "keep-open-on-jump");
  if (exitOnJump === true && keepOpenOnJump === true) {
    throw new Error("Choose either --exit-on-jump or --keep-open-on-jump, not both.");
  }

  return {
    exit_on_jump: keepOpenOnJump === true ? false : true,
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

async function confirmAction(
  prompt: string,
  dependencies: CliDependencies,
): Promise<boolean> {
  const rl = createInterface({
    input: dependencies.stdin,
    output: dependencies.stdout as NodeJS.WritableStream,
  });

  try {
    const response = await rl.question(prompt);
    const normalized = response.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
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
    `context: ${workspace.context_name ?? "none"}`,
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

function formatWorkspaceGroupedList(
  groupedList: WorkspaceSummaryGroupedList,
): string {
  if (groupedList.groups.length === 0) {
    return "No workspaces found.\n";
  }

  return groupedList.groups
    .map((group) =>
      [
        `${group.label} (${group.workspaces.length})`,
        formatWorkspaceList(group.workspaces).trimEnd(),
      ].join("\n"),
    )
    .join("\n\n") + "\n";
}

function formatAgentStatusSnapshot(snapshot: AgentStatusSnapshot): string {
  const lines = [
    `summary: R:${snapshot.summary.counts.running} Q:${snapshot.summary.counts.question} I:${snapshot.summary.counts.idle} E:${snapshot.summary.counts.error}`,
    `active_sessions: ${snapshot.summary.active_sessions}`,
    `generated_at: ${snapshot.summary.generated_at}`,
  ];

  if (snapshot.sources.length > 0) {
    lines.push("sources:");
    for (const source of snapshot.sources) {
      lines.push(
        `- ${source.source}: R:${source.summary.counts.running} Q:${source.summary.counts.question} I:${source.summary.counts.idle} E:${source.summary.counts.error} (${source.summary.active_sessions})`,
      );
    }
  }

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
        agent.agent_name ?? agent.agent_type,
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

function shortenAgentPath(path: string | undefined): string {
  if (path === undefined || path.length === 0) {
    return "-";
  }

  const trimmed = path.replace(/^\/home\/[^/]+\//, "~/");
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.length <= 3) {
    return trimmed;
  }

  return `.../${parts.slice(-3).join("/")}`;
}

function buildAgentMenuRows(
  entries: ReturnType<typeof buildAgentShortcutEntries>,
): string[] {
  const rows = entries.map((entry) => {
    const tmuxLabel =
      entry.agent.tmux === undefined
        ? "-"
        : `${entry.agent.tmux.session_name}/${entry.agent.tmux.window_name}`;
    const nameLabel =
      entry.agent.cwd === undefined
        ? tmuxLabel
        : basename(entry.agent.cwd);
    const pathLabel = shortenAgentPath(entry.agent.cwd);

    return [
      entry.key,
      nameLabel,
      tmuxLabel,
      pathLabel,
      `${entry.agent.agent_type} ${entry.agent.state}`,
    ];
  });

  const widths = rows[0]!.map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]!.length)),
  );

  return rows.map((row) =>
    row
      .map((value, columnIndex) =>
        columnIndex === row.length - 1
          ? value
          : value.padEnd(widths[columnIndex]),
      )
      .join(" | "),
  );
}

function buildHelpText(): string {
  return [
    "Usage:",
    "  pitch [create] (--issue N | --pr N) [--slug SLUG] [--session-id ID] [--tmux-session SESSION] [--additional-dir PATH]... [options] [PROMPT...]",
    "  pitch [create] --name NAME [--branch BRANCH] [--session-id ID] [--tmux-session SESSION] [--additional-dir PATH]... [options] [PROMPT...]",
    "  pitch agents [--pick]",
    "  pitch agents-popup",
    "  pitch jump <session-id-or-prefix>",
    "  pitch agent-status",
    "  pitch agent-error --agent-type TYPE --session-id ID --message TEXT",
    "  pitch list [--repo REPO] [--status active|closed|all] [--sort FIELD[,FIELD...]] [--group-by FIELD]",
    "  pitch get <name>",
    "  pitch resume <name> [--agent AGENT] [--environment ENV] [--context CONTEXT] [--session-id ID] [--tmux-session SESSION] [--additional-dir PATH]... [--reset-session] [--sync]",
    "  pitch restart <name> [--agent AGENT] [--environment ENV] [--context CONTEXT] [--session-id ID] [--tmux-session SESSION] [--additional-dir PATH]... [--reset-session] [--sync]",
    "  pitch move <name> --to SESSION",
    "  pitch rename <name> <new-name>",
    "  pitch close <name>",
    "  pitch delete <name> [--force]",
    "  pitch status-right [--separator TEXT]",
    "  pitch waybar-status [--watch]",
    "  pitch view [--keep-open-on-jump]",
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
    "  --additional-dir PATH",
    "  --environment ENV",
    "  --context CONTEXT",
    "  --cwd PATH",
    "  --transcript-path PATH",
    "  --tty TTY",
    "  --session-id ID",
    "  --tmux-session SESSION",
    "  --to SESSION",
    "  --reset-session",
    "  --message TEXT",
    "  --sync",
    "  --model MODEL",
    "  --prompt TEXT",
    "  --skip-prompt",
    "  --force",
    "  --pick",
    "  --status active|closed|all",
    "  --sort FIELD[,FIELD...]",
    "  --group-by FIELD",
    "  --exit-on-jump",
    "  --keep-open-on-jump",
    "  --json",
    "  --help",
    "",
    "If --issue, --pr, or --name is provided without an explicit command,",
    "create is implied.",
    "Trailing PROMPT text on create is appended to the bootstrap prompt.",
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
    "_pitch_tmux_sessions() {",
    "  local -a sessions",
    "  sessions=(\"${(@f)$(pitch __complete-tmux-sessions 2>/dev/null)}\")",
    "  (( ${#sessions[@]} )) || return 1",
    "  _describe -t tmux-sessions 'tmux session' sessions",
    "}",
    "",
    "_pitch_contexts() {",
    "  local -a pitch_contexts",
    "  pitch_contexts=(\"${(@f)$(pitch __complete-contexts 2>/dev/null)}\")",
    "  (( ${#pitch_contexts[@]} )) || return 1",
    "  _values 'repository context' $pitch_contexts",
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
    "  words=(\"${words[@]:$(( command_index - 1 ))}\")",
    "  CURRENT=$(( CURRENT - command_index + 1 ))",
    "  command_index=1",
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
        "        '--context[Repository launch context]:context:_pitch_contexts' \\",
    "        '--session-id[Resume an existing agent session id]:session id:' \\",
    "        '--tmux-session[Target tmux session]:session:_pitch_tmux_sessions' \\",
    "        '*--additional-dir[Additional directory to grant to the agent]:path:_files -/' \\",
    "        '*--add-dir[Alias for --additional-dir]:path:_files -/' \\",
    "        '--model[Model override]:model:' \\",
    "        '--prompt[Additional bootstrap prompt text]:prompt:' \\",
    "        '--skip-prompt[Skip bootstrap prompt]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '*:additional prompt text:'",
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
    "        '--sort[Comma-separated workspace sort fields]:sort:(status name source repo agent tmux source_kind source_number agent_name agent_type tmux_session tmux_window)' \\",
    "        '--group-by[Workspace grouping field]:field:(status name source repo agent tmux source_kind source_number agent_name agent_type tmux_session tmux_window)' \\",
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
    "    resume|restart)",
    "      _pitch_complete_workspace_target \"$command_index\" && return",
    "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--agent[Configured agent]:agent:' \\",
        "        '--environment[Execution environment]:environment:' \\",
        "        '--context[Repository launch context]:context:_pitch_contexts' \\",
    "        '--session-id[Resume an existing agent session id]:session id:' \\",
    "        '--tmux-session[Target tmux session]:session:_pitch_tmux_sessions' \\",
    "        '*--additional-dir[Additional directory to grant to the agent]:path:_files -/' \\",
    "        '*--add-dir[Alias for --additional-dir]:path:_files -/' \\",
    "        '--reset-session[Start a new agent session instead of resuming]' \\",
    "        '--sync[Fast-forward PR workspaces to latest upstream head before resuming]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    move)",
    "      _pitch_complete_workspace_target \"$command_index\" && return",
    "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--to[Target tmux session]:session:_pitch_tmux_sessions' \\",
    "        '--tmux-session[Target tmux session]:session:_pitch_tmux_sessions' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    rename)",
    "      _pitch_complete_workspace_target \"$command_index\" && return",
    "      _arguments -s -S \\",
    "        '--name[Workspace name]:workspace:_pitch_workspaces' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces' \\",
    "        '2:new workspace name:'",
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
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]' \\",
    "        '1:workspace:_pitch_workspaces'",
    "      ;;",
    "    status-right)",
    "      _arguments -s -S \\",
    "        '--separator[Append this suffix when agent status is present]:text:' \\",
    "        '--tmux-session[Current tmux session]:session:_pitch_tmux_sessions' \\",
    "        '--tmux-window[Current tmux window]:window:' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    waybar-status)",
    "      _arguments -s -S \\",
    "        '--watch[Continuously emit Waybar JSON with animated running indicator]' \\",
    "        '--json[Emit JSON]' \\",
    "        '--help[Show help]'",
    "      ;;",
    "    view)",
    "      _arguments -s -S \\",
    "        '--exit-on-jump[Exit pitch view after goto, the default]' \\",
    "        '--keep-open-on-jump[Keep pitch view open after goto]' \\",
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
    "      'restart[Restart the agent process in a workspace]' \\",
    "      'move[Move a workspace to another tmux session]' \\",
    "      'rename[Rename a workspace and its tmux window]' \\",
    "      'close[Close a workspace]' \\",
    "      'delete[Delete a workspace]' \\",
    "      'status-right[Render an agent status-right segment]' \\",
    "      'waybar-status[Render Waybar agent status JSON]' \\",
    "      'view[Open the workspace TUI]' \\",
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
    "        'restart[Restart the agent process in a workspace]' \\",
    "        'move[Move a workspace to another tmux session]' \\",
    "        'rename[Rename a workspace and its tmux window]' \\",
    "        'close[Close a workspace]' \\",
    "        'delete[Delete a workspace]' \\",
    "        'status-right[Render an agent status-right segment]' \\",
    "        'waybar-status[Render Waybar agent status JSON]' \\",
    "        'view[Open the workspace TUI]' \\",
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
      const input = buildCreateInput(parsed.flags, parsed.positionals);
      const config = await dependencies.loadConfig();
      const warnings: string[] = [];
      const result = await dependencies.createWorkspace(
        input,
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

        const labels = buildAgentMenuRows(entries);
        await dependencies.displayTmuxMenu({
          title: "Pitch Agents",
          x: "P",
          y: "P",
          items: entries.map((entry, index) => ({
            label: labels[index]!,
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
      {
        const sortKeys = buildListSort(parsed.flags);
        const groupBy = buildListGroupBy(parsed.flags);
        const workspaces = sortWorkspaceSummaries(
          await dependencies.listWorkspaces(buildListInput(parsed.flags)),
          sortKeys,
        );

        return {
          command: parsed.verb,
          result:
            groupBy === undefined
              ? workspaces
              : groupWorkspaceSummaries(workspaces, groupBy),
          warnings: [],
        };
      }
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
    case "restart": {
      const config = await dependencies.loadConfig();
      const warnings: string[] = [];
      const result = await dependencies.resumeWorkspace(
        buildRestartInput(parsed.flags, parsed.positionals),
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
    case "move": {
      const config = await dependencies.loadConfig();
      const warnings: string[] = [];
      return {
        command: parsed.verb,
        result: await dependencies.moveWorkspace(
          buildMoveInput(parsed.flags, parsed.positionals),
          config,
          {
            reportWarning: (warning) => warnings.push(warning),
          },
        ),
        warnings,
      };
    }
    case "rename": {
      const config = await dependencies.loadConfig();
      return {
        command: parsed.verb,
        result: await dependencies.renameWorkspace(
          buildRenameInput(parsed.flags, parsed.positionals),
          config,
        ),
        warnings: [],
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
      const input = buildDeleteInput(parsed.flags, parsed.positionals);

      try {
        return {
          command: parsed.verb,
          result: await dependencies.deleteWorkspace(
            input,
            config,
            {
              reportWarning: (warning) => warnings.push(warning),
            },
          ),
          warnings,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldPromptForForceCleanup =
          input.force !== true &&
          message.includes("Failed to remove worktree for") &&
          message.includes("Retry with --force to remove the worktree directory directly.");

        if (
          !shouldPromptForForceCleanup ||
          readBooleanFlag(parsed.flags, "json") === true
        ) {
          throw error;
        }

        const confirmed = await confirmAction(
          `Worktree cleanup via git failed for ${input.name}. Force remove the worktree directory instead? [y/N] `,
          dependencies,
        );
        if (!confirmed) {
          throw error;
        }

        return {
          command: parsed.verb,
          result: await dependencies.deleteWorkspace(
            {
              ...input,
              force: true,
            },
            config,
            {
              reportWarning: (warning) => warnings.push(warning),
            },
          ),
          warnings,
        };
      }
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
    case "waybar-status":
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      return {
        command: parsed.verb,
        result: await dependencies.renderWaybarStatus(),
        warnings: [],
      };
    case "view":
    case "completion":
    case "__complete-workspaces":
    case "__complete-contexts":
    case "__complete-tmux-sessions":
      return null;
  }
}

function isWorkspaceList(
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | WorkspaceSummaryGroupedList
    | AgentStatusSnapshot
    | AgentsView
    | string,
): result is WorkspaceSummary[] {
  return Array.isArray(result);
}

function isWorkspaceGroupedList(
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | WorkspaceSummaryGroupedList
    | AgentStatusSnapshot
    | AgentsView
    | string,
): result is WorkspaceSummaryGroupedList {
  return (
    typeof result === "object" &&
    result !== null &&
    "group_by" in result &&
    "groups" in result &&
    Array.isArray(result.groups)
  );
}

function isAgentStatusSnapshot(
  result:
    | WorkspaceRecord
    | WorkspaceSummary[]
    | WorkspaceSummaryGroupedList
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
    | WorkspaceSummaryGroupedList
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
  } else if (isWorkspaceGroupedList(commandResult.result)) {
    dependencies.stdout.write(formatWorkspaceGroupedList(commandResult.result));
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

    if (parsed.verb === "__complete-contexts") {
      const config = await dependencies.loadConfig();
      const contexts = [
        ...new Set(
          Object.values(config.repos).flatMap((repo) =>
            Object.keys(repo.contexts ?? {}),
          ),
        ),
      ].sort();
      if (contexts.length > 0) {
        dependencies.stdout.write(`${contexts.join("\n")}\n`);
      }
      return 0;
    }

    if (parsed.verb === "__complete-tmux-sessions") {
      const sessions = await dependencies.listTmuxSessions();
      if (sessions.length > 0) {
        dependencies.stdout.write(`${sessions.join("\n")}\n`);
      }
      return 0;
    }

    if (
      parsed.verb === "waybar-status" &&
      readBooleanFlag(parsed.flags, "watch") === true
    ) {
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      await dependencies.watchWaybarStatus(dependencies.stdout);
      return 0;
    }

    if (parsed.verb === "view") {
      ensureNoExtraPositionals(parsed.positionals, parsed.verb);
      await runWorkspaceView(buildViewInput(parsed.flags));
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
