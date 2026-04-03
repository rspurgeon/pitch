import type { PaneCommands } from "./config.js";
import { sendKeysToPane, type TmuxPaneLayout } from "./tmux.js";

export interface PaneCommandDependencies {
  sendKeysToPane: typeof sendKeysToPane;
  reportWarning?: (warning: string) => void;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function sendConfiguredPaneCommands(
  workspaceName: string,
  paneCommands: PaneCommands | undefined,
  panes: Pick<TmuxPaneLayout, "top_right_pane_id" | "bottom_right_pane_id">,
  dependencies: PaneCommandDependencies,
): Promise<void> {
  if (paneCommands === undefined) {
    return;
  }

  const configuredCommands = [
    {
      pane_name: "top_right",
      pane_id: panes.top_right_pane_id,
      command: paneCommands.top_right,
    },
    {
      pane_name: "bottom_right",
      pane_id: panes.bottom_right_pane_id,
      command: paneCommands.bottom_right,
    },
  ];

  for (const configuredCommand of configuredCommands) {
    if (configuredCommand.command === undefined) {
      continue;
    }

    try {
      await dependencies.sendKeysToPane({
        pane_id: configuredCommand.pane_id,
        command: configuredCommand.command,
      });
    } catch (error: unknown) {
      dependencies.reportWarning?.(
        `Failed to send ${configuredCommand.pane_name} pane command to ${workspaceName}: ${formatError(error)}`,
      );
    }
  }
}
