function defaultPaneProcessForAgent(agentType: string): string {
  return agentType;
}

export function getAcceptedAgentPaneProcesses(
  agentType: string,
  paneProcessName?: string,
): string[] {
  const providedProcess = paneProcessName?.trim();
  const defaultProcess = defaultPaneProcessForAgent(agentType);
  const accepted = new Set<string>();

  if (providedProcess !== undefined && providedProcess.length > 0) {
    accepted.add(providedProcess);
  }

  const shouldAcceptAgentProcess =
    providedProcess === undefined ||
    providedProcess.length === 0 ||
    providedProcess === defaultProcess ||
    providedProcess !== "ssh";

  if (shouldAcceptAgentProcess && defaultProcess.length > 0) {
    accepted.add(defaultProcess);
  }

  if (shouldAcceptAgentProcess && agentType === "codex") {
    accepted.add("node");
  }

  return [...accepted];
}

export function matchesAgentPaneProcess(
  currentCommand: string,
  agentType: string,
  paneProcessName?: string,
): boolean {
  return getAcceptedAgentPaneProcesses(agentType, paneProcessName).includes(
    currentCommand,
  );
}
