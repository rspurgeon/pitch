import type { BuiltAgentCommand } from "./agent-launcher.js";
import { shellEscape } from "./shell.js";

function shouldAllowShellExpansion(value: string): boolean {
  return (
    value === "~" ||
    value.startsWith("~/") ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
  );
}

function formatEnvAssignment(key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable name: ${key}`);
  }

  const renderedValue = shouldAllowShellExpansion(value)
    ? value
    : shellEscape(value);
  return `${key}=${renderedValue}`;
}

export function formatAgentPaneCommand(command: BuiltAgentCommand): string {
  const envAssignments = Object.entries(command.env).map(([key, value]) =>
    formatEnvAssignment(key, value),
  );
  const argv = command.command.map((part) => shellEscape(part));

  return [...envAssignments, "command", "--", ...argv].join(" ");
}
