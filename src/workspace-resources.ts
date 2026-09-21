import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { PitchConfig, ProvisionerDefinition, ProvisionerSelection } from "./config.js";
import { environmentScript, expandEnvironmentPath, mergeEnvironment, validateEnvironmentName } from "./workspace-environment.js";

export interface ResourceRecord {
  definition: ProvisionerDefinition;
  selection: ProvisionerSelection;
  status: "creating" | "ready" | "deactivated";
  outputs?: Record<string, unknown>;
  created_at?: string;
  deactivated_at?: string;
  cleanup?: {
    outcome: "deactivated" | "not_created";
    confirmed_at: string;
    retention_days?: number;
  };
}

export interface ResourceState {
  version: 1;
  id: string;
  repo: string;
  workspace_name: string;
  context?: string;
  completed?: boolean;
  provisioners: Record<string, ResourceRecord>;
}

export interface PrepareEnvironmentInput {
  config: PitchConfig;
  repo: string;
  name: string;
  context?: string;
  resource_id?: string;
  allow_create?: boolean;
  root?: string;
}

export interface PreparedEnvironment {
  config: PitchConfig;
  resource_id: string;
  directory: string;
  environment_file: string;
  environment: Record<string, string>;
}

export function workspaceResourceId(repo: string, name: string): string {
  return createHash("sha256").update(`${repo}\0${name}`).digest("hex").slice(0, 32);
}

export function resourceDirectory(id: string, root = join(homedir(), ".pitch", "resources")): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid workspace resource ID");
  return join(root, id);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  const file = await open(temp, "w", 0o600);
  try { await file.chmod(0o600); await file.writeFile(contents); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
}

export async function readResourceState(directory: string, filename = "resources.json"): Promise<ResourceState | undefined> {
  try {
    const state = JSON.parse(await readFile(join(directory, filename), "utf8")) as ResourceState;
    if (state.version !== 1 || typeof state.repo !== "string" || typeof state.workspace_name !== "string" ||
        !state.provisioners || typeof state.provisioners !== "object" || Array.isArray(state.provisioners)) {
      throw new Error("Invalid resource ownership record");
    }
    for (const [name, record] of Object.entries(state.provisioners)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || !["creating", "ready", "deactivated"].includes(record.status) ||
          !record.selection || !record.definition ||
          ![record.definition.create, record.definition.delete].every((cmd) => Array.isArray(cmd) && cmd.length > 0 && cmd.every((arg) => typeof arg === "string"))) {
        throw new Error("Invalid provisioner ownership record");
      }
    }
    return state;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error(`Invalid resource state JSON: ${directory}`);
    throw error;
  }
}

export async function saveState(directory: string, state: ResourceState, filename = "resources.json"): Promise<void> {
  await atomicWrite(join(directory, filename), `${JSON.stringify(state, null, 2)}\n`);
}

async function locked<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".lock");
  try { await mkdir(lock); }
  catch { throw new Error(`Workspace resources are locked: ${lock}. If the previous process died, remove this lock after confirming it is no longer running.`); }
  try { return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export function renderTemplate(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/{{\s*([^{}]+?)\s*}}/g, (_, expression: string) => {
      const [path, filter, extra] = expression.split("|").map((s) => s.trim());
      if (extra || (filter && filter !== "env_key")) throw new Error(`Unknown template filter: ${expression}`);
      let result: unknown = scope;
      for (const part of path.split(".")) {
        if (!result || typeof result !== "object" || !Object.hasOwn(result, part)) {
          throw new Error(`Unknown template reference: ${path}`);
        }
        result = (result as Record<string, unknown>)[part];
      }
      if (typeof result !== "string" && typeof result !== "number" && typeof result !== "boolean") {
        throw new Error(`Template reference is not a scalar: ${path}`);
      }
      return filter === "env_key" ? String(result).toUpperCase().replace(/[.-]/g, "_") : String(result);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, scope));
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [renderTemplate(key, scope) as string, renderTemplate(item, scope)] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Duplicate generated template key");
    return Object.fromEntries(entries);
  }
  return value;
}

export class ProvisionerCredentialFileError extends Error {
  constructor(readonly variable: string, readonly path: string, readonly reason: string, readonly code?: string) {
    super(`Cannot read credential file for ${variable} at ${path}: ${reason}`);
  }
}

async function provisionerEnvironment(record: ResourceRecord): Promise<NodeJS.ProcessEnv> {
  const bindings = mergeEnvironment(record.definition, record.selection);
  const env = { ...process.env, ...bindings.env };
  for (const [key, path] of Object.entries(bindings.env_from_files)) {
    validateEnvironmentName(key);
    const expanded = expandEnvironmentPath(path);
    try { env[key] = (await readFile(expanded, "utf8")).replace(/\n+$/, ""); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === "ENOENT" ? "file missing" : code === "EACCES" || code === "EPERM" ? "permission denied" : "read failed";
      throw new ProvisionerCredentialFileError(key, expanded, reason, code);
    }
  }
  return env;
}

async function invoke(
  action: "create" | "delete" | "inspect", record: ResourceRecord, state: ResourceState, directory: string, name: string,
  preparedEnv?: NodeJS.ProcessEnv,
  inspection?: { verify: boolean; archived: boolean },
): Promise<Record<string, unknown>> {
  const command = record.definition[action];
  if (!command?.length) throw new Error(`Provisioner ${name} has no ${action} command`);
  const env = preparedEnv ?? await provisionerEnvironment(record);
  const resourceDir = join(directory, name);
  if (action !== "inspect") await mkdir(resourceDir, { recursive: true, mode: 0o700 });
  const input = {
    version: 1,
    workspace: { id: state.id, name: state.workspace_name, repo: state.repo },
    resource_dir: resourceDir,
    inputs: record.selection.inputs,
    outputs: record.outputs,
    ...(inspection ? { ...inspection, created_at: record.created_at } : {}),
  };
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = execFile(expandEnvironmentPath(command[0]), command.slice(1), {
      env, timeout: record.definition.timeout_ms ?? 120000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      // Helpers must not expose secrets through diagnostics. Do not forward arbitrary stdout/stderr.
      if (error) reject(new Error(`Provisioner ${name} ${action} failed. State retained at ${resourceDir}; inspect its receipt before retrying.`));
      else resolveOutput(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  });
  let result;
  try { result = JSON.parse(output); }
  catch { throw new Error(`Provisioner ${name} returned invalid JSON`); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`Invalid output from provisioner ${name}`);
  if (action === "delete" && result.deactivated !== true) throw new Error(`Provisioner ${name} did not confirm deactivation`);
  return result;
}

export async function inspectWorkspaceResource(
  record: ResourceRecord, state: ResourceState, directory: string, name: string,
  command: string[], verify: boolean, archived: boolean,
): Promise<Record<string, unknown>> {
  const inspectRecord = { ...record, definition: { ...record.definition, inspect: command } };
  return invoke("inspect", inspectRecord, state, directory, name,
    verify ? undefined : { ...process.env }, { verify, archived });
}

async function deactivateRecords(directory: string, state: ResourceState, provisioner?: string): Promise<void> {
  for (const [name, record] of Object.entries(state.provisioners).reverse()) {
    if (provisioner !== undefined && name !== provisioner) continue;
    if (record.status === "deactivated") continue;
    const result = await invoke("delete", record, state, directory, name);
    record.status = "deactivated";
    record.deactivated_at = new Date().toISOString();
    record.cleanup = {
      outcome: result.not_created === true ? "not_created" : "deactivated",
      confirmed_at: record.deactivated_at,
      ...(typeof result.retention_days === "number" && Number.isInteger(result.retention_days) && result.retention_days >= 0
        ? { retention_days: result.retention_days } : {}),
    };
    await saveState(directory, state);
  }
}

export async function cleanupWorkspaceResources(id?: string, root?: string, provisioner?: string): Promise<void> {
  if (!id) return;
  const directory = resourceDirectory(id, root);
  await locked(directory, async () => {
    const state = await readResourceState(directory);
    if (!state || state.id !== id) throw new Error(`Missing or mismatched ownership record: ${directory}`);
    if (provisioner !== undefined && !Object.hasOwn(state.provisioners, provisioner)) {
      throw new Error(`Provisioner ${provisioner} has no resource in this workspace`);
    }
    await deactivateRecords(directory, state, provisioner);
    state.completed = Object.values(state.provisioners).every((record) => record.status === "deactivated");
    await saveState(directory, state);
    await rm(join(directory, "environment.sh"), { force: true });
  });
}

export async function prepareWorkspaceEnvironment(input: PrepareEnvironmentInput): Promise<PreparedEnvironment> {
  const id = input.resource_id ?? workspaceResourceId(input.repo, input.name);
  const directory = resourceDirectory(id, input.root);
  return locked(directory, async () => {
    const repo = input.config.repos[input.repo];
    if (!repo) throw new Error(`Unknown repository: ${input.repo}`);
    const contextName = input.context ?? repo.default_context;
    const context = contextName ? repo.contexts?.[contextName] : undefined;
    if (contextName && !context) throw new Error(`Unknown context: ${contextName}`);
    let state = await readResourceState(directory);
    if (state && (state.id !== id || state.repo !== input.repo)) throw new Error("Resource ownership mismatch");
    if (input.allow_create && state && !state.completed && Object.keys(state.provisioners).length) {
      throw new Error(`Resources already exist for this workspace identity: ${directory}. Resume the owning workspace or clean up its resources before creating another.`);
    }
    if (state?.completed) {
      if (!input.allow_create) throw new Error("Workspace resources have been deactivated");
      await atomicWrite(join(directory, `completed-${Date.now()}.json`), JSON.stringify(state));
      // The helper's old receipts and tokens cannot be reused for a new workspace generation.
      for (const name of Object.keys(state.provisioners)) await rm(join(directory, name), { recursive: true, force: true });
      state = undefined;
    }
    state ??= { version: 1, id, repo: input.repo, workspace_name: input.name, context: contextName, provisioners: {} };
    const scope: Record<string, unknown> = {
      workspace: { id, name: state.workspace_name, resource_dir: directory },
      context: context ?? {}, provisioners: {}, files: {},
    };
    const selected = context?.provisioners ?? {};
    // Changing a provisioned context must not silently create or replace resources.
    if (Object.keys(selected).length && state.context !== contextName) {
      throw new Error("Cannot switch provisioned contexts on an existing workspace; create a separate workspace");
    }
    await saveState(directory, state);
    try {
      for (const [name, selection] of Object.entries(selected)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid provisioner name: ${name}`);
        let record = Object.hasOwn(state.provisioners, name) ? state.provisioners[name] : undefined;
        let preparedEnv: NodeJS.ProcessEnv | undefined;
        if (!record) {
          if (!input.allow_create) throw new Error("Provisioning is only performed during workspace creation");
          const definition = input.config.provisioners && Object.hasOwn(input.config.provisioners, name)
            ? input.config.provisioners[name] : undefined;
          if (!definition) throw new Error(`Unknown provisioner: ${name}`);
          record = { definition, selection: renderTemplate(selection, scope) as ProvisionerSelection, status: "creating", created_at: new Date().toISOString() };
          // A credential-file failure cannot have created any external resources.
          // Resolve it before recording that a create command might have run.
          preparedEnv = await provisionerEnvironment(record);
          state.provisioners[name] = record;
          await saveState(directory, state);
        }
        if (record.status === "deactivated") throw new Error(`Provisioner ${name} has already been deactivated`);
        if (record.status === "creating") {
          if (!input.allow_create) throw new Error(`Incomplete provisioning: ${directory}`);
          record.outputs = await invoke("create", record, state, directory, name, preparedEnv);
          record.status = "ready";
          await saveState(directory, state);
        }
        (scope.provisioners as Record<string, unknown>)[name] = { outputs: record.outputs };
      }
      for (const [name, file] of Object.entries(context?.generated_files ?? {})) {
        const path = resolve(renderTemplate(file.path, scope) as string);
        const rel = relative(join(directory, "files"), path);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Generated files must stay inside workspace.resource_dir/files");
        (scope.files as Record<string, unknown>)[name] = path;
        await atomicWrite(path, stringify(renderTemplate(file.contents, scope)));
      }
      const bindings = renderTemplate(mergeEnvironment(repo, context), scope) as ReturnType<typeof mergeEnvironment>;
      [...Object.keys(bindings.env), ...Object.keys(bindings.env_from_files)].forEach(validateEnvironmentName);
      for (const path of Object.values(bindings.env_from_files)) await readFile(expandEnvironmentPath(path));
      const privateNames = new Set<string>();
      for (const definition of Object.values(input.config.provisioners ?? {})) {
        Object.keys(definition.env ?? {}).forEach((key) => privateNames.add(key));
        Object.keys(definition.env_from_files ?? {}).forEach((key) => privateNames.add(key));
      }
      for (const ctx of Object.values(repo.contexts ?? {})) for (const selection of Object.values(ctx.provisioners ?? {})) {
        Object.keys(selection.env ?? {}).forEach((key) => privateNames.add(key));
        Object.keys(selection.env_from_files ?? {}).forEach((key) => privateNames.add(key));
      }
      for (const name of privateNames) {
        if (Object.hasOwn(bindings.env, name) || Object.hasOwn(bindings.env_from_files, name)) {
          throw new Error(`Provisioner credential ${name} cannot also be a workspace environment binding`);
        }
      }
      const environmentFile = join(directory, "environment.sh");
      await atomicWrite(environmentFile, environmentScript(bindings, environmentFile, input.name, [...privateNames]));
      const config = { ...input.config, repos: { ...input.config.repos, [input.repo]: {
        ...repo, ...bindings,
        contexts: { ...repo.contexts, ...(contextName ? { [contextName]: { ...context, env: {}, env_from_files: {} } } : {}) },
      } } };
      return { config, resource_id: id, directory, environment_file: environmentFile, environment: bindings.env };
    } catch (error) {
      if (input.allow_create) {
        try {
          await deactivateRecords(directory, state);
          state.completed = true;
          await saveState(directory, state);
          await rm(join(directory, "environment.sh"), { force: true });
        }
        catch { throw new Error(`Workspace setup and rollback failed; retain and recover resources at ${directory}. Original error: ${(error as Error).message}`); }
      }
      throw error;
    }
  });
}
