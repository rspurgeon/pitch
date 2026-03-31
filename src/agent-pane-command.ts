import type { BuiltAgentCommand } from "./agent-launcher.js";
import { formatEnvAssignment, shellEscape } from "./shell.js";

export function formatAgentPaneCommand(
  command: BuiltAgentCommand,
  reuseExistingConnection = false,
): string {
  if (reuseExistingConnection) {
    if (command.pane_reuse_command === undefined) {
      throw new Error("Agent command does not support connection reuse");
    }

    return command.pane_reuse_command;
  }

  const envAssignments = Object.entries(command.env).map(([key, value]) =>
    formatEnvAssignment(key, value),
  );
  const argv = command.command.map((part) => shellEscape(part));

  return [...envAssignments, "command", "--", ...argv].join(" ");
}
