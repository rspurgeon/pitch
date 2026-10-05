import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PitchConfig } from "../config.js";
import type { WorkspaceRecord } from "../workspace-state.js";
import { listWorkspaceRecords, readWorkspaceRecord, writeWorkspaceRecord } from "../workspace-state.js";
import { cleanupWorkspaceResources, prepareWorkspaceEnvironment, workspaceResourceId } from "../workspace-resources.js";
import { cleanupWorkspaceProvisioner, refreshWorkspaceEnvironment, reprovisionWorkspaceProvisioner } from "../workspace-maintenance.js";

vi.mock("../workspace-state.js", async (original) => ({
  ...await original<typeof import("../workspace-state.js")>(),
  readWorkspaceRecord: vi.fn(), listWorkspaceRecords: vi.fn(), writeWorkspaceRecord: vi.fn(),
}));
vi.mock("../workspace-resources.js", async (original) => ({
  ...await original<typeof import("../workspace-resources.js")>(),
  cleanupWorkspaceResources: vi.fn(), prepareWorkspaceEnvironment: vi.fn(),
}));

const config = { defaults: { repo: "owner/repo" } } as PitchConfig;
const workspace = { name: "example", repo: "owner/repo", status: "closed", resource_id: "a".repeat(32),
  environment_kind: "host", context_name: "ephemeral" } as WorkspaceRecord;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readWorkspaceRecord).mockResolvedValue(workspace);
  vi.mocked(listWorkspaceRecords).mockResolvedValue([workspace]);
});

describe("workspace maintenance", () => {
  it("reprovisions with saved ownership while preserving the checkout and agent fields", async () => {
    vi.mocked(prepareWorkspaceEnvironment).mockResolvedValue({ resource_id: workspace.resource_id!,
      directory: "/workspace", environment_file: "/workspace/environment.sh", config, environment: {} });
    expect(await reprovisionWorkspaceProvisioner("example", "example", config)).toBe("/workspace/environment.sh");
    expect(prepareWorkspaceEnvironment).toHaveBeenCalledWith({ config, repo: workspace.repo, name: workspace.name,
      resource_id: workspace.resource_id, context: workspace.context_name, reprovision: "example" });
    expect(writeWorkspaceRecord).toHaveBeenCalledWith({ ...workspace, environment_file: "/workspace/environment.sh", updated_at: expect.any(String) });
  });

  it("refuses reprovisioning missing, active, remote, or unowned workspaces before touching resources", async () => {
    for (const [record, message] of [
      [null, "Workspace not found"], [{ ...workspace, status: "active" }, "Close the workspace"],
      [{ ...workspace, environment_kind: "vm-ssh" }, "host workspace"], [{ ...workspace, resource_id: undefined }, "resource identity"],
    ] as const) {
      vi.mocked(readWorkspaceRecord).mockResolvedValue(record);
      await expect(reprovisionWorkspaceProvisioner("example", "example", config)).rejects.toThrow(message);
    }
    expect(prepareWorkspaceEnvironment).not.toHaveBeenCalled();
  });
  it("uses the saved identity and requested provisioner for cleanup", async () => {
    await cleanupWorkspaceProvisioner("example", "example", config);
    expect(cleanupWorkspaceResources).toHaveBeenCalledWith(workspace.resource_id, undefined, "example");
  });

  it("recovers interrupted creation using an explicit repository", async () => {
    vi.mocked(readWorkspaceRecord).mockResolvedValue(null);
    vi.mocked(listWorkspaceRecords).mockResolvedValue([]);
    await cleanupWorkspaceProvisioner("example", "interrupted", config, "other/repo");
    expect(cleanupWorkspaceResources).toHaveBeenCalledWith(workspaceResourceId("other/repo", "interrupted"), undefined, "example");
  });

  it("refuses cleanup of an active workspace, a renamed owner, or a mismatched repo", async () => {
    vi.mocked(readWorkspaceRecord).mockResolvedValue({ ...workspace, status: "active" });
    await expect(cleanupWorkspaceProvisioner("example", "example", config)).rejects.toThrow("Close the workspace");
    vi.mocked(readWorkspaceRecord).mockResolvedValue(workspace);
    await expect(cleanupWorkspaceProvisioner("example", "example", config, "other/repo")).rejects.toThrow("belongs to");
    vi.mocked(listWorkspaceRecords).mockResolvedValue([{ ...workspace, name: "renamed" }]);
    await expect(cleanupWorkspaceProvisioner("example", "example", config)).rejects.toThrow("use its current name");
    expect(cleanupWorkspaceResources).not.toHaveBeenCalled();
  });

  it("refreshes existing outputs without enabling resource creation", async () => {
    vi.mocked(prepareWorkspaceEnvironment).mockResolvedValue({ resource_id: workspace.resource_id!,
      directory: "/workspace", environment_file: "/workspace/environment.sh", config, environment: {} });
    expect(await refreshWorkspaceEnvironment("example", config)).toBe("/workspace/environment.sh");
    expect(prepareWorkspaceEnvironment).toHaveBeenCalledWith({ config, repo: workspace.repo, name: "example",
      context: "ephemeral", resource_id: workspace.resource_id });
    expect(writeWorkspaceRecord).toHaveBeenCalledWith(expect.objectContaining({ environment_file: "/workspace/environment.sh" }));
  });

  it("rejects refresh for missing or remote workspaces", async () => {
    vi.mocked(readWorkspaceRecord).mockResolvedValue(null);
    await expect(refreshWorkspaceEnvironment("missing", config)).rejects.toThrow("Workspace not found");
    vi.mocked(readWorkspaceRecord).mockResolvedValue({ ...workspace, environment_kind: "vm-ssh" });
    await expect(refreshWorkspaceEnvironment("example", config)).rejects.toThrow("requires a host workspace");
    expect(prepareWorkspaceEnvironment).not.toHaveBeenCalled();
  });
});
