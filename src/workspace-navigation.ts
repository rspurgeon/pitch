import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  focusTmuxPaneInClient,
  getTmuxWindowPane,
  listTmuxClients,
} from "./tmux.js";
import type { WorkspaceSummary } from "./workspace-query.js";

const execFileAsync = promisify(execFile);

interface HyprlandClient {
  address: string;
  class: string;
  title: string;
  workspace: {
    id: number;
    name: string;
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseHyprlandClients(raw: string): HyprlandClient[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("hyprctl clients returned unexpected JSON.");
  }

  return parsed.flatMap((client): HyprlandClient[] => {
    if (
      typeof client !== "object" ||
      client === null ||
      !("address" in client) ||
      !("class" in client) ||
      !("title" in client) ||
      !("workspace" in client)
    ) {
      return [];
    }

    const workspace = client.workspace;
    if (
      typeof workspace !== "object" ||
      workspace === null ||
      !("id" in workspace) ||
      !("name" in workspace)
    ) {
      return [];
    }

    return [{
      address: String(client.address),
      class: String(client.class),
      title: String(client.title),
      workspace: {
        id: Number(workspace.id),
        name: String(workspace.name),
      },
    }];
  });
}

async function listHyprlandClients(): Promise<HyprlandClient[]> {
  const { stdout } = await execFileAsync("hyprctl", ["clients", "-j"]);
  return parseHyprlandClients(stdout);
}

function isTerminalClient(client: HyprlandClient): boolean {
  return client.class === "Alacritty" || client.class.toLowerCase().includes("terminal");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleMentionsToken(title: string, token: string): boolean {
  const titleParts = title.split("•").map((part) => part.trim());
  if (titleParts.includes(token)) {
    return true;
  }

  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_-])${escapeRegExp(token)}($|[^A-Za-z0-9_-])`,
  );
  return pattern.test(title);
}

function selectTerminalForWorkspace(
  clients: HyprlandClient[],
  workspace: WorkspaceSummary,
): HyprlandClient | undefined {
  const matchingSessionClients = clients.filter(
    (client) =>
      isTerminalClient(client) &&
      titleMentionsToken(client.title, workspace.tmux_session),
  );

  return (
    matchingSessionClients.find((client) =>
      titleMentionsToken(client.title, workspace.tmux_window),
    ) ?? matchingSessionClients[0]
  );
}

async function focusHyprlandClient(client: HyprlandClient): Promise<void> {
  await execFileAsync("hyprctl", [
    "dispatch",
    "workspace",
    String(client.workspace.id),
  ]);
  await execFileAsync("hyprctl", [
    "dispatch",
    "focuswindow",
    `address:${client.address}`,
  ]);
}

export async function gotoWorkspace(
  workspace: WorkspaceSummary,
): Promise<string> {
  const paneId = await getTmuxWindowPane({
    session_name: workspace.tmux_session,
    window_name: workspace.tmux_window,
    pane_index: 0,
  });

  let terminal: HyprlandClient | undefined;
  try {
    terminal = selectTerminalForWorkspace(
      await listHyprlandClients(),
      workspace,
    );
  } catch (error: unknown) {
    throw new Error(`Hyprland lookup failed: ${formatError(error)}`);
  }

  if (terminal === undefined) {
    throw new Error(
      `No open desktop terminal found for tmux session ${workspace.tmux_session}.`,
    );
  }

  await focusHyprlandClient(terminal);

  const tmuxClients = await listTmuxClients();
  const tmuxClient = tmuxClients.find(
    (client) => client.session_name === workspace.tmux_session,
  );
  if (tmuxClient === undefined) {
    return `Focused desktop ${terminal.workspace.name}; no attached tmux client found for ${workspace.tmux_session}.`;
  }

  await focusTmuxPaneInClient({
    session_name: workspace.tmux_session,
    window_name: workspace.tmux_window,
    pane_id: paneId,
    client_name: tmuxClient.client_name,
  });

  return `Focused desktop ${terminal.workspace.name} ${workspace.tmux_session}:${workspace.tmux_window}.`;
}
