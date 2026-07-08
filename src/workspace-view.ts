import { spawn } from "node:child_process";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { loadConfig } from "./config.js";
import { deleteWorkspace } from "./close-workspace.js";
import { gotoWorkspace } from "./workspace-navigation.js";
import {
  listWorkspaces,
  type WorkspaceSummary,
} from "./workspace-query.js";

type ViewMode =
  | "normal"
  | "filter"
  | "create"
  | "resume"
  | "restart"
  | "confirm-delete";
type StatusTone = "info" | "success" | "error";

interface StatusMessage {
  text: string;
  tone: StatusTone;
}

interface WorkspaceGroup {
  status: WorkspaceSummary["status"];
  workspaces: WorkspaceSummary[];
}

export interface WorkspaceViewOptions {
  exit_on_jump?: boolean;
}

type WorkspaceListRow =
  | {
      kind: "heading";
      key: string;
      label: string;
    }
  | {
      kind: "workspace";
      key: string;
      workspace: WorkspaceSummary;
    };

function e<P extends object>(
  component: React.ComponentType<P> | string,
  props: (P & React.Attributes) | null,
  ...children: React.ReactNode[]
): React.ReactElement {
  return React.createElement(component, props, ...children);
}

function compareWorkspaces(
  left: WorkspaceSummary,
  right: WorkspaceSummary,
): number {
  const statusOrder = left.status.localeCompare(right.status);
  if (statusOrder !== 0) {
    return left.status === "active" ? -1 : 1;
  }

  return left.name.localeCompare(right.name);
}

function sourceLabel(workspace: WorkspaceSummary): string {
  return workspace.source_number === null
    ? workspace.source_kind
    : `${workspace.source_kind}#${workspace.source_number}`;
}

function tmuxLabel(workspace: WorkspaceSummary): string {
  return `${workspace.tmux_session}:${workspace.tmux_window}`;
}

function groupByStatus(workspaces: WorkspaceSummary[]): WorkspaceGroup[] {
  const active = workspaces.filter((workspace) => workspace.status === "active");
  const closed = workspaces.filter((workspace) => workspace.status === "closed");
  const groups: WorkspaceGroup[] = [
    { status: "active", workspaces: active },
    { status: "closed", workspaces: closed },
  ];
  return groups.filter((group) => group.workspaces.length > 0);
}

function flattenWorkspaceRows(groups: WorkspaceGroup[]): WorkspaceListRow[] {
  return groups.flatMap((group) => [
    {
      kind: "heading" as const,
      key: `${group.status}-heading`,
      label: `${group.status} (${group.workspaces.length})`,
    },
    ...group.workspaces.map((workspace) => ({
      kind: "workspace" as const,
      key: workspace.name,
      workspace,
    })),
  ]);
}

function sliceRowsAroundSelection(
  rows: WorkspaceListRow[],
  selectedName: string | undefined,
  maxRows: number,
): WorkspaceListRow[] {
  if (maxRows <= 0 || rows.length <= maxRows) {
    return rows;
  }

  const selectedRowIndex = rows.findIndex(
    (row) => row.kind === "workspace" && row.workspace.name === selectedName,
  );
  if (selectedRowIndex === -1) {
    return rows.slice(0, maxRows);
  }

  const preferredStart = selectedRowIndex - Math.floor(maxRows / 2);
  const maxStart = Math.max(0, rows.length - maxRows);
  const start = Math.min(Math.max(0, preferredStart), maxStart);
  return rows.slice(start, start + maxRows);
}

function filterWorkspaces(
  workspaces: WorkspaceSummary[],
  filter: string,
): WorkspaceSummary[] {
  const normalized = filter.trim().toLowerCase();
  if (normalized.length === 0) {
    return workspaces;
  }

  return workspaces.filter((workspace) =>
    [
      workspace.name,
      workspace.repo,
      workspace.status,
      workspace.agent_name,
      workspace.agent_type,
      sourceLabel(workspace),
      tmuxLabel(workspace),
    ].some((value) => value.toLowerCase().includes(normalized)),
  );
}

function filterWorkspacesByStatusVisibility(
  workspaces: WorkspaceSummary[],
  showActive: boolean,
  showClosed: boolean,
): WorkspaceSummary[] {
  return workspaces.filter((workspace) =>
    workspace.status === "active" ? showActive : showClosed,
  );
}

function trimLine(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function shellSplit(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote !== null) {
    throw new Error("Unclosed quote in arguments.");
  }
  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

async function runPitchCommand(
  command: "create" | "resume" | "restart",
  args: string[],
  successMessage: string,
): Promise<string> {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error(`Cannot resolve Pitch entrypoint for ${command}.`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ...process.execArgv,
      entrypoint,
      command,
      ...args,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const details = stderr.trim() || stdout.trim();
        reject(
          new Error(
            details || `${command} failed with exit code ${code ?? "unknown"}.`,
          ),
        );
        return;
      }

      resolve(successMessage);
    });
  });
}

async function runCreateFromArgs(input: string): Promise<string> {
  return runPitchCommand("create", shellSplit(input), "Workspace created.");
}

async function runResumeFromArgs(
  name: string,
  input: string,
  restart: boolean,
): Promise<string> {
  const command = restart ? "restart" : "resume";
  const label = restart ? "Restarted" : "Resumed";
  return runPitchCommand(command, [name, ...shellSplit(input)], `${label} ${name}.`);
}

async function loadWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
  const workspaces = await listWorkspaces({ status: "all" });
  return [...workspaces].sort(compareWorkspaces);
}

function statusColor(tone: StatusTone): "blue" | "green" | "red" {
  switch (tone) {
    case "error":
      return "red";
    case "success":
      return "green";
    case "info":
      return "blue";
  }
}

function WorkspaceRow({
  workspace,
  selected,
}: {
  workspace: WorkspaceSummary;
  selected: boolean;
}): React.ReactElement {
  const marker = selected ? ">" : " ";
  const color = workspace.status === "active" ? "green" : "gray";
  return e(
    Text,
    {
      inverse: selected,
      color: selected ? undefined : color,
      wrap: "truncate-end",
    },
    `${marker} ${trimLine(workspace.name, 34).padEnd(34)} ` +
      `${sourceLabel(workspace).padEnd(10)} ` +
      `${workspace.agent_name.padEnd(10)} ` +
      trimLine(tmuxLabel(workspace), 28),
  );
}

function WorkspaceHeader(): React.ReactElement {
  return e(
    Text,
    { dimColor: true, wrap: "truncate-end" },
    "  " +
      "Name".padEnd(34) +
      " " +
      "Source".padEnd(10) +
      " " +
      "Agent".padEnd(10) +
      " " +
      "Tmux",
  );
}

function WorkspaceList({
  groups,
  selectedName,
  maxRows,
}: {
  groups: WorkspaceGroup[];
  selectedName: string | undefined;
  maxRows: number;
}): React.ReactElement {
  if (groups.length === 0) {
    return e(Text, { dimColor: true }, "No workspaces found.");
  }

  const rows = sliceRowsAroundSelection(
    flattenWorkspaceRows(groups),
    selectedName,
    maxRows,
  );

  return e(
    Box,
    { flexDirection: "column", height: maxRows, overflow: "hidden" },
    ...rows.map((row) =>
      row.kind === "heading"
        ? e(Text, { key: row.key, bold: true, color: "white" }, row.label)
        : e(WorkspaceRow, {
            key: row.key,
            workspace: row.workspace,
            selected: row.workspace.name === selectedName,
          }),
    ),
  );
}

function WorkspaceDetail({
  workspace,
}: {
  workspace: WorkspaceSummary | undefined;
}): React.ReactElement {
  if (workspace === undefined) {
    return e(Text, { dimColor: true }, "No workspace selected.");
  }

  const lines = [
    ["Name", workspace.name],
    ["Repo", workspace.repo],
    ["Source", sourceLabel(workspace)],
    ["Status", workspace.status],
    ["Agent", `${workspace.agent_name} (${workspace.agent_type})`],
    ["Tmux", tmuxLabel(workspace)],
  ];

  return e(
    Box,
    { flexDirection: "column" },
    ...lines.map(([label, value]) =>
      e(Text, { key: label }, `${label.padEnd(7)} ${value}`),
    ),
  );
}

function Prompt({
  mode,
  value,
  selected,
}: {
  mode: ViewMode;
  value: string;
  selected: WorkspaceSummary | undefined;
}): React.ReactElement | null {
  if (mode === "filter") {
    return e(Text, { color: "cyan" }, `filter: ${value}`);
  }

  if (mode === "confirm-delete") {
    return e(
      Text,
      { color: "red" },
      `Delete ${selected?.name ?? "workspace"}? Press D to confirm, Esc to cancel.`,
    );
  }

  return null;
}

function HelpItem({
  keys,
  label,
}: {
  keys: string;
  label: string;
}): React.ReactElement {
  return e(
    Text,
    null,
    e(Text, { color: "yellow", bold: true }, keys),
    e(Text, { dimColor: true }, ` ${label}`),
  );
}

function HelpBar({
  exitOnJump,
  showActive,
  showClosed,
}: {
  exitOnJump: boolean;
  showActive: boolean;
  showClosed: boolean;
}): React.ReactElement {
  const items = [
    ["enter/g", exitOnJump ? "goto+quit" : "goto"],
    ["R", "resume"],
    ["X", "restart"],
    ["c", "create"],
    ["d", "delete"],
    ["/", "filter"],
    ["u", "clear filter"],
    ["a", showActive ? "hide active" : "show active"],
    ["C", showClosed ? "hide closed" : "show closed"],
    ["r", "refresh"],
    ["q", "quit"],
  ] as const;

  return e(
    Box,
    { flexDirection: "row", flexWrap: "wrap", columnGap: 2 },
    ...items.map(([keys, label]) =>
      e(HelpItem, { key: keys, keys, label }),
    ),
  );
}

function InputBox({
  value,
  width,
}: {
  value: string;
  width: number;
}): React.ReactElement {
  const innerWidth = Math.max(1, width - 2);
  const visibleValue = trimLine(value, width - 1);
  const inputLine = ` ${visibleValue}`.padEnd(width);
  return e(
    Box,
    { flexDirection: "column", width },
    e(Text, { color: "gray" }, `+${"-".repeat(innerWidth)}+`),
    e(Text, { color: "cyan" }, inputLine),
    e(Text, { color: "gray" }, `+${"-".repeat(innerWidth)}+`),
  );
}

function ArgsDialog({
  mode,
  value,
  selected,
  terminalColumns,
  terminalRows,
}: {
  mode: "create" | "resume" | "restart";
  value: string;
  selected: WorkspaceSummary | undefined;
  terminalColumns: number;
  terminalRows: number;
}): React.ReactElement {
  const dialogWidth = Math.max(1, Math.min(72, terminalColumns - 4));
  const dialogHeight = Math.min(9, Math.max(6, terminalRows - 2));
  const inputWidth = Math.max(1, dialogWidth - 8);
  const title =
    mode === "create"
      ? "Create new workspace with the following args:"
      : `${mode === "restart" ? "Restart" : "Resume"} ${selected?.name ?? "workspace"} with the following args:`;
  const actionLabel =
    mode === "create" ? "create" : mode === "restart" ? "restart" : "resume";

  return e(
    Box,
    {
      position: "absolute",
      left: 0,
      top: 0,
      width: terminalColumns,
      height: terminalRows,
      alignItems: "center",
      justifyContent: "center",
    },
    e(
      Box,
      {
        width: dialogWidth,
        height: dialogHeight,
        flexDirection: "column",
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        paddingY: 1,
        backgroundColor: "black",
      },
      e(Text, { bold: true, wrap: "truncate-end" }, title),
      e(
        Box,
        {
          alignSelf: "center",
          marginTop: 1,
          width: inputWidth,
        },
        e(InputBox, { value, width: inputWidth }),
      ),
      e(
        Box,
        { marginTop: 1, flexDirection: "row", columnGap: 2 },
        e(HelpItem, { keys: "enter", label: actionLabel }),
        e(HelpItem, { keys: "esc", label: "cancel" }),
      ),
    ),
  );
}

function WorkspaceView({
  exitOnJump,
}: {
  exitOnJump: boolean;
}): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [promptValue, setPromptValue] = useState("");
  const [mode, setMode] = useState<ViewMode>("normal");
  const [loading, setLoading] = useState(false);
  const [showActive, setShowActive] = useState(true);
  const [showClosed, setShowClosed] = useState(false);
  const [status, setStatus] = useState<StatusMessage>({
    text: "Loading workspaces...",
    tone: "info",
  });

  const refresh = useCallback(async (message = "Refreshed workspaces.") => {
    setLoading(true);
    try {
      const nextWorkspaces = await loadWorkspaceSummaries();
      setWorkspaces(nextWorkspaces);
      setStatus({ text: message, tone: "success" });
    } catch (error: unknown) {
      setStatus({
        text: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh("Loaded workspaces.");
  }, [refresh]);

  const visibleWorkspaces = useMemo(
    () =>
      filterWorkspaces(
        filterWorkspacesByStatusVisibility(workspaces, showActive, showClosed),
        filter,
      ),
    [filter, showActive, showClosed, workspaces],
  );
  const selectedWorkspace = visibleWorkspaces[selectedIndex];
  const groups = useMemo(
    () => groupByStatus(visibleWorkspaces),
    [visibleWorkspaces],
  );
  const terminalRows = Math.max(1, rows);
  const terminalColumns = Math.max(1, columns);
  const rootPaddingX = terminalColumns >= 40 ? 1 : 0;
  const showDetails = terminalColumns >= 96;
  const footerMarginTop = terminalRows >= 10 ? 1 : 0;
  const preferredFooterHeight =
    mode === "filter" || mode === "confirm-delete" ? 5 : 4;
  const footerHeight = Math.min(
    preferredFooterHeight,
    Math.max(1, terminalRows - 1 - footerMarginTop),
  );
  const mainHeight = Math.max(1, terminalRows - footerHeight - footerMarginTop);
  const listBodyHeight = Math.max(1, mainHeight - 3);
  const detailWidth = showDetails
    ? clamp(Math.floor(terminalColumns * 0.32), 34, 52)
    : 0;

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(visibleWorkspaces.length - 1, 0)),
    );
  }, [visibleWorkspaces.length]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<string>) => {
      setLoading(true);
      setStatus({ text: `${label}...`, tone: "info" });
      try {
        const message = await action();
        await refresh(message);
      } catch (error: unknown) {
        setStatus({
          text: error instanceof Error ? error.message : String(error),
          tone: "error",
        });
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );

  useInput((input, key) => {
    if (
      mode === "filter" ||
      mode === "create" ||
      mode === "resume" ||
      mode === "restart"
    ) {
      if (key.escape) {
        setPromptValue("");
        if (mode === "filter") {
          setFilter("");
          setSelectedIndex(0);
          setStatus({ text: "Cleared filter.", tone: "info" });
        } else {
          setStatus({ text: "Cancelled.", tone: "info" });
        }
        setMode("normal");
        return;
      }
      if (key.backspace || key.delete) {
        setPromptValue((current) => {
          const nextValue = current.slice(0, -1);
          if (mode === "filter") {
            setFilter(nextValue);
            setSelectedIndex(0);
          }
          return nextValue;
        });
        return;
      }
      if (key.return) {
        const value = promptValue.trim();
        const currentMode = mode;
        setPromptValue("");
        setMode("normal");
        if (currentMode === "filter") {
          setFilter(value);
          setSelectedIndex(0);
          setStatus({
            text: value.length === 0 ? "Cleared filter." : `Filter: ${value}`,
            tone: "info",
          });
        } else if (currentMode === "create" && value.length > 0) {
          void runAction("Creating workspace", async () => runCreateFromArgs(value));
        } else if (
          (currentMode === "resume" || currentMode === "restart") &&
          selectedWorkspace !== undefined
        ) {
          const name = selectedWorkspace.name;
          const restart = currentMode === "restart";
          void runAction(`${restart ? "Restarting" : "Resuming"} ${name}`, async () =>
            runResumeFromArgs(name, value, restart),
          );
        }
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setPromptValue((current) => {
          const nextValue = current + input;
          if (mode === "filter") {
            setFilter(nextValue);
            setSelectedIndex(0);
          }
          return nextValue;
        });
      }
      return;
    }

    if (mode === "confirm-delete") {
      if (key.escape || input === "d") {
        setMode("normal");
        setStatus({ text: "Delete cancelled.", tone: "info" });
        return;
      }
      if (input === "D" && selectedWorkspace !== undefined) {
        const name = selectedWorkspace.name;
        setMode("normal");
        void runAction(`Deleting ${name}`, async () => {
          const config = await loadConfig();
          await deleteWorkspace({ name }, config);
          return `Deleted ${name}.`;
        });
      }
      return;
    }

    if (input === "q" || (input === "c" && key.ctrl)) {
      exit();
      return;
    }
    if (key.upArrow || input === "k") {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setSelectedIndex((current) =>
        Math.min(Math.max(visibleWorkspaces.length - 1, 0), current + 1),
      );
      return;
    }
    if (input === "/") {
      setPromptValue(filter);
      setMode("filter");
      return;
    }
    if (input === "u") {
      setFilter("");
      setPromptValue("");
      setSelectedIndex(0);
      setStatus({ text: "Cleared filter.", tone: "info" });
      return;
    }
    if (input === "a") {
      setShowActive((current) => {
        const next = !current;
        setSelectedIndex(0);
        setStatus({
          text: next ? "Showing active workspaces." : "Hiding active workspaces.",
          tone: "info",
        });
        return next;
      });
      return;
    }
    if (input === "C") {
      setShowClosed((current) => {
        const next = !current;
        setSelectedIndex(0);
        setStatus({
          text: next ? "Showing closed workspaces." : "Hiding closed workspaces.",
          tone: "info",
        });
        return next;
      });
      return;
    }
    if (input === "r") {
      void refresh();
      return;
    }
    if (input === "c") {
      setPromptValue("");
      setMode("create");
      return;
    }
    if (input === "d" && selectedWorkspace !== undefined) {
      setMode("confirm-delete");
      return;
    }
    if ((input === "g" || key.return) && selectedWorkspace !== undefined) {
      const workspace = selectedWorkspace;
      setLoading(true);
      setStatus({ text: `Going to ${workspace.name}...`, tone: "info" });
      void (async () => {
        try {
          await gotoWorkspace(workspace);
          if (exitOnJump) {
            exit();
            return;
          }

          await refresh(`Focused ${tmuxLabel(workspace)}.`);
        } catch (error: unknown) {
          setStatus({
            text: error instanceof Error ? error.message : String(error),
            tone: "error",
          });
          setLoading(false);
        }
      })();
      return;
    }
    if (input === "R" && selectedWorkspace !== undefined) {
      setPromptValue("");
      setMode("resume");
      return;
    }
    if (input === "X" && selectedWorkspace !== undefined) {
      setPromptValue("");
      setMode("restart");
    }
  });

  return e(
    Box,
    {
      flexDirection: "column",
      width: terminalColumns,
      height: terminalRows,
      paddingX: rootPaddingX,
    },
    e(
      Box,
      { height: mainHeight, gap: showDetails ? 1 : 0 },
      e(
        Box,
        {
          flexDirection: "column",
          flexGrow: 1,
          borderStyle: "single",
          borderColor: "gray",
          paddingX: 1,
          height: mainHeight,
        },
        e(WorkspaceHeader, null),
        e(WorkspaceList, {
          groups,
          selectedName: selectedWorkspace?.name,
          maxRows: listBodyHeight,
        }),
      ),
      showDetails
        ? e(
            Box,
            {
              flexDirection: "column",
              width: detailWidth,
              borderStyle: "single",
              borderColor: "gray",
              paddingX: 1,
              height: mainHeight,
            },
            e(Text, { bold: true }, "Details"),
            e(WorkspaceDetail, { workspace: selectedWorkspace }),
          )
        : null,
    ),
    e(
      Box,
      {
        marginTop: footerMarginTop,
        flexDirection: "column",
        borderStyle: "single",
        borderColor: "gray",
        paddingX: 1,
        height: footerHeight,
      },
      e(HelpBar, { exitOnJump, showActive, showClosed }),
      e(
        Text,
        { color: statusColor(status.tone), wrap: "truncate-end" },
        status.text,
      ),
      e(Prompt, { mode, value: promptValue, selected: selectedWorkspace }),
    ),
    mode === "create" || mode === "resume" || mode === "restart"
      ? e(ArgsDialog, {
          mode,
          value: promptValue,
          selected: selectedWorkspace,
          terminalColumns,
          terminalRows,
        })
      : null,
  );
}

export async function runWorkspaceView(
  options: WorkspaceViewOptions = {},
): Promise<void> {
  const instance = render(e(WorkspaceView, {
    exitOnJump: options.exit_on_jump ?? true,
  }), {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
}
