import type { BuiltAgentCommand } from "./agent-launcher.js";
import type { SendKeysToPaneParams, TmuxPaneInfo } from "./tmux.js";

export interface PostLaunchPromptDependencies {
  getTmuxPaneInfo: (params: { pane_id: string }) => Promise<TmuxPaneInfo>;
  sendKeysToPane: (params: SendKeysToPaneParams) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  reportWarning?: (warning: string) => void;
}

const POST_LAUNCH_PROMPT_POLL_INTERVAL_MS = 100;
const POST_LAUNCH_PROMPT_TIMEOUT_MS = 5000;
const OPENCODE_POST_LAUNCH_PROMPT_SETTLE_MS = 10000;

async function waitForPaneCommand(
  paneId: string,
  expectedCommand: string,
  dependencies: PostLaunchPromptDependencies,
): Promise<boolean> {
  const maxAttempts = Math.ceil(
    POST_LAUNCH_PROMPT_TIMEOUT_MS / POST_LAUNCH_PROMPT_POLL_INTERVAL_MS,
  );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const paneInfo = await dependencies.getTmuxPaneInfo({
        pane_id: paneId,
      });
      if (paneInfo.current_command === expectedCommand) {
        return true;
      }
    } catch {
      // ignore transient pane lookup failures during startup
    }

    await dependencies.sleep(POST_LAUNCH_PROMPT_POLL_INTERVAL_MS);
  }

  return false;
}

export async function sendPostLaunchPromptToPane(
  paneId: string,
  prompt: string,
  command: BuiltAgentCommand,
  workspaceName: string,
  dependencies: PostLaunchPromptDependencies,
): Promise<void> {
  if (command.agent_type === "opencode") {
    const ready = await waitForPaneCommand(paneId, "opencode", dependencies);
    if (!ready) {
      dependencies.reportWarning?.(
        `Timed out waiting for OpenCode to become ready before sending bootstrap prompt to ${workspaceName}`,
      );
    }

    await dependencies.sleep(OPENCODE_POST_LAUNCH_PROMPT_SETTLE_MS);
    await dependencies.sendKeysToPane({
      pane_id: paneId,
      command: prompt,
      literal: true,
    });
    return;
  }

  await dependencies.sendKeysToPane({
    pane_id: paneId,
    command: prompt,
  });
}
