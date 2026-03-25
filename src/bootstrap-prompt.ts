import type { PitchConfig } from "./config.js";
import type { WorkspaceSourceKind } from "./workspace-state.js";

export interface BootstrapPromptContext {
  repo: string;
  source_kind: WorkspaceSourceKind;
  source_number: number;
  workspace_name: string;
  branch: string;
}

const DEFAULT_BOOTSTRAP_PROMPTS: Record<WorkspaceSourceKind, string> = {
  issue:
    "Read GitHub issue #{issue_number} in {repo} using gh, understand the task, and wait for the next instruction. Do not make changes yet.",
  pr:
    "Read GitHub PR #{pr_number} in {repo} using gh, understand the current change, and wait for the next instruction. Do not make changes yet.",
};

function resolveTemplate(
  config: PitchConfig,
  repoName: string,
  sourceKind: WorkspaceSourceKind,
): string {
  return (
    config.repos[repoName]?.bootstrap_prompts[sourceKind] ??
    config.bootstrap_prompts[sourceKind] ??
    DEFAULT_BOOTSTRAP_PROMPTS[sourceKind]
  );
}

export function buildBootstrapPrompt(
  config: PitchConfig,
  context: BootstrapPromptContext,
): string {
  const template = resolveTemplate(config, context.repo, context.source_kind);

  return template
    .replaceAll("{repo}", context.repo)
    .replaceAll("{workspace_name}", context.workspace_name)
    .replaceAll("{branch}", context.branch)
    .replaceAll(
      "{issue_number}",
      context.source_kind === "issue" ? String(context.source_number) : "",
    )
    .replaceAll(
      "{pr_number}",
      context.source_kind === "pr" ? String(context.source_number) : "",
    );
}
