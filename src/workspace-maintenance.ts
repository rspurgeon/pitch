import type { PitchConfig } from "./config.js";
import { listWorkspaceRecords, readWorkspaceRecord, writeWorkspaceRecord } from "./workspace-state.js";
import { cleanupWorkspaceResources, prepareWorkspaceEnvironment, resourceDirectory, workspaceResourceId } from "./workspace-resources.js";

export async function cleanupWorkspaceProvisioner(provisioner: string, name: string, config: PitchConfig, repo?: string, abandonReason?: string): Promise<string> {
  const workspace = await readWorkspaceRecord(name);
  if (workspace && repo && workspace.repo !== repo) throw new Error(`Workspace ${name} belongs to ${workspace.repo}, not ${repo}`);
  const repoName = workspace?.repo ?? repo ?? config.defaults.repo;
  if (!repoName) throw new Error("Specify --repo to recover resources without a workspace record");
  const id = workspace?.resource_id ?? workspaceResourceId(repoName, name);
  const owner = (await listWorkspaceRecords({ status: "all" })).find((entry) => entry.resource_id === id);
  if (owner && owner.name !== name) throw new Error(`Resources belong to workspace ${owner.name}; use its current name`);
  if (workspace?.status === "active") throw new Error("Close the workspace before cleaning up its resources");
  if (abandonReason !== undefined) {
    await cleanupWorkspaceResources(id, undefined, provisioner, abandonReason);
    return `${provisioner} abandoned locally; remote deletion unconfirmed. Receipt retained at ${resourceDirectory(id)} until workspace deletion and history expiry.`;
  }
  await cleanupWorkspaceResources(id, undefined, provisioner);
  return `${provisioner} deactivated; receipt retained at ${resourceDirectory(id)}`;
}

export async function refreshWorkspaceEnvironment(name: string, config: PitchConfig): Promise<string> {
  const workspace = await readWorkspaceRecord(name);
  if (!workspace) throw new Error(`Workspace not found: ${name}`);
  if (workspace.environment_kind === "vm-ssh") throw new Error("Environment refresh currently requires a host workspace");
  const prepared = await prepareWorkspaceEnvironment({ config, repo: workspace.repo, name: workspace.name,
    context: workspace.context_name, resource_id: workspace.resource_id });
  await writeWorkspaceRecord({ ...workspace, resource_id: prepared.resource_id,
    environment_file: prepared.environment_file, updated_at: new Date().toISOString() });
  return prepared.environment_file;
}

export async function reprovisionWorkspaceProvisioner(provisioner: string, name: string, config: PitchConfig): Promise<string> {
  const workspace = await readWorkspaceRecord(name);
  if (!workspace) throw new Error(`Workspace not found: ${name}`);
  if (workspace.status !== "closed") throw new Error("Close the workspace before reprovisioning its resources");
  if (workspace.environment_kind === "vm-ssh") throw new Error("Reprovision requires a host workspace");
  if (!workspace.resource_id) throw new Error("Workspace has no recorded resource identity");
  const prepared = await prepareWorkspaceEnvironment({ config, repo: workspace.repo, name: workspace.name,
    context: workspace.context_name, resource_id: workspace.resource_id, reprovision: provisioner });
  await writeWorkspaceRecord({ ...workspace, environment_file: prepared.environment_file, updated_at: new Date().toISOString() });
  return prepared.environment_file;
}
