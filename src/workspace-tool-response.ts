import type { WorkspaceRecord } from "./workspace-state.js";

export function buildWorkspaceToolResponse(
  workspace: WorkspaceRecord,
  warnings: string[] = [],
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: WorkspaceRecord;
} {
  return {
    content: [
      { type: "text", text: JSON.stringify(workspace) },
      ...warnings.map((warning) => ({
        type: "text" as const,
        text: `Warning: ${warning}`,
      })),
    ],
    structuredContent: workspace,
  };
}
