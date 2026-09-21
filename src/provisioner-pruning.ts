import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PitchConfig } from "./config.js";
import { listWorkspaceRecords } from "./workspace-state.js";
import { readResourceState, saveState, type ResourceRecord } from "./workspace-resources.js";

export interface PruneInput {
  provisioner?: string;
  repo?: string;
  dry_run?: boolean;
}

export interface PruneResult {
  dry_run: boolean;
  items: { workspace: string; provisioner: string; record: string; status: "pruned" | "would prune" | "retained"; reason: string }[];
  warnings: string[];
}

interface PruneDependencies {
  root: string;
  now: () => number;
  listWorkspaceRecords: typeof listWorkspaceRecords;
}

function expiration(record: ResourceRecord, buffer: number): number | undefined {
  const cleanup = record.cleanup;
  if (!cleanup || !["deactivated", "not_created"].includes(cleanup.outcome)) return undefined;
  const confirmed = typeof cleanup.confirmed_at === "string" ? Date.parse(cleanup.confirmed_at) : NaN;
  const retention = cleanup.outcome === "not_created" ? 0 : cleanup.retention_days;
  if (!Number.isFinite(confirmed) || typeof retention !== "number" || !Number.isSafeInteger(retention) || retention < 0 ||
      !Number.isSafeInteger(buffer) || buffer < 0) return undefined;
  const expires = confirmed + (retention + buffer) * 86400000;
  return Number.isFinite(expires) && !Number.isNaN(new Date(expires).getTime()) ? expires : undefined;
}

// Only local ownership records are read. No inspector, credentials, or API calls.
export async function pruneProvisionerHistory(
  input: PruneInput,
  config: PitchConfig,
  overrides: Partial<PruneDependencies> = {},
): Promise<PruneResult> {
  const deps = { root: join(homedir(), ".pitch", "resources"), now: Date.now, listWorkspaceRecords, ...overrides };
  const result: PruneResult = { dry_run: input.dry_run === true, items: [], warnings: [] };
  let entries: Dirent[];
  try { entries = await readdir(deps.root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read provisioner history directory");
    entries = [];
  }
  // Fail closed if ownership cannot be established, including for dry runs.
  const owners = await deps.listWorkspaceRecords({ status: "all" });
  let known = input.provisioner === undefined || Object.hasOwn(config.provisioners ?? {}, input.provisioner);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = join(deps.root, entry.name);
    const lock = join(directory, ".lock");
    let acquired = false;
    let empty = false;
    try {
      if (!result.dry_run) {
        // Share the provisioning/cleanup lock; never recreate a missing directory.
        await mkdir(lock);
        acquired = true;
      } else if ((await readdir(directory)).includes(".lock")) {
        result.warnings.push(`History is busy; retry pruning: ${directory}`);
        continue;
      }
      const currentOwners = result.dry_run ? owners : await deps.listWorkspaceRecords({ status: "all" });
      const owned = currentOwners.some((workspace) => workspace.resource_id === entry.name);
      const filenames = (await readdir(directory)).filter((name) => name === "resources.json" || /^completed-\d+\.json$/.test(name)).sort();
      for (const filename of filenames) {
        const state = await readResourceState(directory, filename);
        if (!state || state.id !== entry.name) throw new Error("Invalid ownership record");
        if (input.provisioner && Object.hasOwn(state.provisioners, input.provisioner)) known = true;
        if (input.repo && state.repo !== input.repo) continue;
        const current = filename === "resources.json";
        for (const [name, record] of Object.entries(state.provisioners)) {
          if ((input.provisioner && name !== input.provisioner) || record.status !== "deactivated") continue;
          const buffer = config.provisioners?.[name]?.history_buffer_days ?? record.definition.history_buffer_days ?? 7;
          const expires = expiration(record, buffer);
          const reason = current && owned ? "Workspace still references this record"
            : expires === undefined ? "Missing cleanup evidence or retention period; reconcile before pruning"
            : deps.now() < expires ? `Retained until ${new Date(expires).toISOString()}` : "Retention and buffer elapsed";
          const eligible = !(current && owned) && expires !== undefined && deps.now() >= expires;
          const row: PruneResult["items"][number] = { workspace: state.workspace_name, provisioner: name,
            record: join(directory, filename), status: eligible ? result.dry_run ? "would prune" : "pruned" : "retained", reason };
          if (eligible && !result.dry_run) {
            // Archived records share a directory with the new generation. Never
            // touch current assets when pruning an archived generation.
            if (current) await rm(join(directory, name), { recursive: true, force: true });
            delete state.provisioners[name];
            if (Object.keys(state.provisioners).length) await saveState(directory, state, filename);
            else await rm(join(directory, filename));
          }
          result.items.push(row);
        }
      }
      if (!result.dry_run && !owned) {
        const remaining = await readdir(directory);
        const hasRecords = remaining.some((name) => name === "resources.json" || /^completed-\d+\.json$/.test(name));
        // Remove generated assets only after every generation has been pruned.
        if (!hasRecords && result.items.some((item) => item.status === "pruned" && item.record.startsWith(`${directory}/`))) {
          for (const name of remaining) if (name !== ".lock") await rm(join(directory, name), { recursive: true, force: true });
          empty = true;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      result.warnings.push(code === "EEXIST" ? `History is busy; retry pruning: ${directory}`
        : `Could not prune history; inspect retained records: ${directory}`);
    } finally {
      if (acquired) await rm(lock, { recursive: true, force: true });
    }
    // rmdir is deliberately non-recursive: a concurrent create may now own it.
    if (empty) { try { await rmdir(directory); } catch { /* Keep any newly created assets. */ } }
  }
  if (!known) throw new Error(`Unknown provisioner: ${input.provisioner}`);
  return result;
}

export async function automaticallyPruneHistory(config: PitchConfig, reportWarning?: (warning: string) => void): Promise<void> {
  try {
    const result = await pruneProvisionerHistory({}, config);
    for (const warning of result.warnings) reportWarning?.(warning);
  } catch {
    reportWarning?.("Local history pruning failed; retry with pitch prune <provisioner>.");
  }
}

export function formatPruneResult(result: PruneResult): string {
  const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  if (!result.items.length) return "No completed history records to prune.\n";
  return result.items.map((item) => `${safe(item.workspace)} (${safe(item.provisioner)}): ${item.status} — ${item.reason}`).join("\n") + "\n";
}
