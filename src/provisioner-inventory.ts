import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PitchConfig } from "./config.js";
import { listWorkspaceRecords } from "./workspace-state.js";
import { inspectWorkspaceResource, ProvisionerCredentialFileError, readResourceState, type ResourceState } from "./workspace-resources.js";

export interface ProvisionerInventoryInput {
  provisioner: string;
  repo?: string;
  all?: boolean;
  orphaned?: boolean;
  verify?: boolean;
}

export interface ProvisionerInventoryRow {
  resource_id: string;
  record: string;
  archived: boolean;
  provisioner: string;
  repo: string;
  workspace: string;
  workspace_status: "active" | "closed" | "missing";
  status: "active workspace" | "closed workspace" | "orphaned" | "needs attention" | "deactivated";
  orphaned: boolean;
  lifecycle: "creating" | "ready" | "deactivated";
  name: string | null;
  id: string | null;
  environment: string | null;
  created_at: string | null;
  deactivated_at: string | null;
  remote_state: string | null;
  verification: "not requested" | "verified" | "failed";
  inspection_error?: string;
}

export interface ProvisionerInventory {
  kind: "provisioner_inventory";
  provisioner: string;
  verify: boolean;
  items: ProvisionerInventoryRow[];
  warnings: string[];
}

interface InventoryDependencies {
  root: string;
  listWorkspaceRecords: typeof listWorkspaceRecords;
  inspectWorkspaceResource: typeof inspectWorkspaceResource;
}

// Only these explicit metadata fields are rendered; never dump inputs, outputs,
// command definitions, credentials, or arbitrary helper diagnostics.
function textField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 512)
    : null;
}

export async function provisionerCompletionNames(root = join(homedir(), ".pitch", "resources")):
  Promise<{ provisioners: string[]; workspaces: string[] }> {
  const provisioners = new Set<string>();
  const workspaces = new Set<string>();
  let entries: Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return { provisioners: [], workspaces: [] }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      for (const filename of (await readdir(directory)).filter((name) => name === "resources.json" || /^completed-\d+\.json$/.test(name))) {
        const state = await readResourceState(directory, filename);
        if (!state || state.id !== entry.name) continue;
        for (const name of Object.keys(state.provisioners)) provisioners.add(name);
        if (filename === "resources.json" && Object.values(state.provisioners).some((record) => record.status !== "deactivated")) {
          workspaces.add(state.workspace_name);
        }
      }
    } catch { /* Completion is best effort and never invokes provisioners. */ }
  }
  return { provisioners: [...provisioners].sort(), workspaces: [...workspaces].sort() };
}

// Translate a closed diagnostic vocabulary, never helper messages or API bodies.
function verificationDiagnostic(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const diagnostic = value as Record<string, unknown>;
  const phase = diagnostic.phase === "authentication" ? "Service authentication"
    : diagnostic.phase === "token_exchange" ? "Resource token exchange"
    : diagnostic.phase === "state_lookup" ? "Remote state lookup" : "Remote verification";
  switch (diagnostic.code) {
    case "missing_resource_id":
      return "Missing or invalid resource ID; verification skipped. Review the creation record before cleanup.";
    case "missing_credentials":
      return `${phase}: missing credentials. Check provisioner env/env_from_files.`;
    case "transport_error":
      return `${phase}: connection or timeout error. Check network access; retry --verify.`;
    case "invalid_response":
      return `${phase}: unexpected response. Contact the service team.`;
    case "http_error": {
      const status = diagnostic.status;
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return undefined;
      const advice = status === 401 ? "Check this environment's service credentials."
        : status === 403 ? "Ask the service team to check client permissions."
        : status === 404 ? "Check ID/environment; deactivation is unconfirmed."
        : status === 429 || status >= 500 ? "Retry --verify later."
        : "Contact the service team.";
      return `${phase}: HTTP ${status}. ${advice}`;
    }
    default: return undefined;
  }
}

function inspectionFailure(error: unknown): string {
  if (error instanceof ProvisionerCredentialFileError) {
    return `${textField(error.variable)}: ${error.reason} (${textField(error.path)}). Fix env_from_files or file permissions.`;
  }
  return "Inspect helper failed. Check its command and ownership receipt.";
}

function inspectionWarning(row: ProvisionerInventoryRow): string {
  return `${textField(row.name ?? row.workspace)}: ${row.inspection_error}\n  Record: ${textField(row.record)}`;
}

export async function listProvisionerInventory(
  input: ProvisionerInventoryInput,
  config: PitchConfig,
  overrides: Partial<InventoryDependencies> = {},
): Promise<ProvisionerInventory> {
  const deps: InventoryDependencies = {
    root: join(homedir(), ".pitch", "resources"),
    listWorkspaceRecords,
    inspectWorkspaceResource,
    ...overrides,
  };
  const warnings: string[] = [];
  const records: { directory: string; filename: string; state: ResourceState }[] = [];
  let entries: Dirent[];
  try { entries = await readdir(deps.root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read provisioner inventory directory");
    entries = [];
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = join(deps.root, entry.name);
    let filenames = ["resources.json"];
    if (input.all) {
      try { filenames.push(...(await readdir(directory)).filter((name) => /^completed-\d+\.json$/.test(name)).sort()); }
      catch { warnings.push(`Cannot read archived records in ${directory}`); }
    }
    for (const filename of filenames) {
      try {
        const state = await readResourceState(directory, filename);
        if (!state) continue;
        if (state.id !== entry.name) throw new Error("Ownership mismatch");
        records.push({ directory, filename, state });
      } catch {
        warnings.push(`Cannot read a valid ownership record at ${join(directory, filename)}`);
      }
    }
  }
  const available = new Set([
    ...Object.keys(config.provisioners ?? {}),
    ...records.flatMap(({ state }) => Object.keys(state.provisioners)),
  ]);
  if (!available.has(input.provisioner)) {
    throw new Error(`Unknown provisioner: ${input.provisioner}. Available provisioners: ${[...available].sort().join(", ") || "none"}`);
  }
  let workspaces;
  try { workspaces = await deps.listWorkspaceRecords({ status: "all" }); }
  catch { throw new Error("Cannot read workspace records; refusing to classify orphaned resources"); }
  const items: ProvisionerInventoryRow[] = [];
  for (const { directory, filename, state } of records) {
    if (input.repo && state.repo !== input.repo) continue;
    if (!Object.hasOwn(state.provisioners, input.provisioner)) continue;
    const record = state.provisioners[input.provisioner];
    const archived = filename !== "resources.json";
    const completed = state.completed === true || record.status === "deactivated";
    if (!input.all && completed) continue;
    const owner = archived ? undefined : workspaces.find((workspace) => workspace.resource_id === state.id && workspace.repo === state.repo);
    const orphaned = !completed && !owner;
    if (input.orphaned && !orphaned) continue;
    const row: ProvisionerInventoryRow = {
      resource_id: state.id, record: join(directory, filename), archived,
      provisioner: input.provisioner, repo: state.repo,
      workspace: owner?.name ?? state.workspace_name,
      workspace_status: owner?.status ?? "missing",
      status: completed ? "deactivated" : orphaned ? "orphaned" : record.status === "creating" ? "needs attention"
        : owner?.status === "closed" ? "closed workspace" : "active workspace",
      orphaned, lifecycle: record.status,
      name: null, id: null, environment: null,
      created_at: record.created_at ?? null, deactivated_at: record.deactivated_at ?? null,
      remote_state: null, verification: "not requested",
    };
    const definition = Object.hasOwn(config.provisioners ?? {}, input.provisioner)
      ? config.provisioners?.[input.provisioner] : undefined;
    const command = definition?.inspect ?? record.definition.inspect;
    let localBlocker: string | undefined;
    if (command) {
      // Local inspection happens first so a verification failure never erases
      // available metadata or makes a tracked organization disappear.
      try {
        const local = await deps.inspectWorkspaceResource(record, state, directory, input.provisioner, command, false, archived);
        row.name = textField(local.name);
        row.id = textField(local.id);
        row.environment = textField(local.environment);
        row.created_at = textField(local.created_at) ?? row.created_at;
        row.deactivated_at = textField(local.deactivated_at) ?? row.deactivated_at;
        localBlocker = verificationDiagnostic(local.verification_error);
      } catch (error) {
        row.inspection_error = inspectionFailure(error);
        warnings.push(inspectionWarning(row));
      }
    }
    if (input.verify) {
      row.verification = "failed";
      if (!command) {
        row.inspection_error = `Missing inspect command. Set provisioners.${input.provisioner}.inspect.`;
      } else if (localBlocker) {
        row.inspection_error = localBlocker;
      } else {
        try {
          const remote = await deps.inspectWorkspaceResource(record, state, directory, input.provisioner, command, true, archived);
          row.remote_state = textField(remote.remote_state);
          if (remote.verified !== true || !row.remote_state) {
            row.inspection_error = verificationDiagnostic(remote.verification_error)
              ?? "Remote state unconfirmed. Check the inspect helper and ownership receipt.";
          } else {
            row.verification = "verified";
          }
        } catch (error) {
          row.inspection_error = inspectionFailure(error);
        }
      }
      if (row.verification === "failed") warnings.push(inspectionWarning(row));
    }
    items.push(row);
  }
  items.sort((a, b) => a.workspace.localeCompare(b.workspace) || (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.record.localeCompare(b.record));
  return { kind: "provisioner_inventory", provisioner: input.provisioner, verify: input.verify === true, items, warnings };
}

export function formatProvisionerInventory(inventory: ProvisionerInventory): string {
  if (!inventory.items.length) return `No matching ${inventory.provisioner} records.\n`;
  const rows = [
    ["NAME", "ID", "ENV", "WORKSPACE", "STATUS", "CREATED", ...(inventory.verify ? ["REMOTE"] : [])],
    ...inventory.items.map((item) => [
      item.name ?? "—", item.id ?? "—", item.environment ?? "—", item.workspace,
      `${item.status}${item.orphaned && item.lifecycle === "creating" ? " (creating)" : ""}${item.inspection_error ? " *" : ""}`, item.created_at ?? "—",
      ...(inventory.verify ? [item.verification === "verified" ? item.remote_state! : "unverified"] : []),
    ]),
  ].map((row) => row.map((cell) => textField(cell) ?? "—"));
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column])).join("  ")).join("\n")
    + (inventory.verify ? "\n" : "\n\nLocal records; remote state not checked.\n");
}
