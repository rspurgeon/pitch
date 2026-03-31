import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

function isSafeWorkspaceName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

const WorkspaceNameSchema = z
  .string()
  .refine(isSafeWorkspaceName, { message: "Invalid workspace name" });

const TimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string(),
);

export const AgentRuntimeSchema = z.enum(["native", "docker"]);
export const ExecutionEnvironmentKindSchema = z.enum(["host", "vm-ssh"]);
export const WorkspaceStatusSchema = z.enum(["active", "closed"]);
export const WorkspaceSourceKindSchema = z.enum(["issue", "pr"]);

export const AgentSessionSchema = z.object({
  id: z.string(),
  started_at: TimestampSchema,
  status: z.string(),
}).strict();

export const WorkspaceRecordSchema = z.object({
  name: WorkspaceNameSchema,
  repo: z.string(),
  source_kind: WorkspaceSourceKindSchema,
  source_number: z.number().int().positive(),
  branch: z.string(),
  worktree_path: z.string(),
  base_branch: z.string(),
  tmux_session: z.string(),
  tmux_window: z.string(),
  agent_name: z.string(),
  agent_type: z.string(),
  agent_runtime: AgentRuntimeSchema,
  environment_name: z.string().nullable().optional(),
  environment_kind: ExecutionEnvironmentKindSchema.optional(),
  guest_worktree_path: z.string().optional(),
  agent_pane_process: z.string().optional(),
  agent_env: z.record(z.string(), z.string()).default({}),
  agent_sessions: z.array(AgentSessionSchema).default([]),
  status: WorkspaceStatusSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
}).strict();

const ListWorkspacesOptionsSchema = z.object({
  status: z.enum(["active", "closed", "all"]).optional(),
  repo: z.string().optional(),
}).strict();

export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
export type ExecutionEnvironmentKind = z.infer<
  typeof ExecutionEnvironmentKindSchema
>;
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type WorkspaceSourceKind = z.infer<typeof WorkspaceSourceKindSchema>;
export type ListWorkspacesOptions = z.infer<typeof ListWorkspacesOptionsSchema>;

export class WorkspaceStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceStateError";
  }
}

export const DEFAULT_WORKSPACES_DIR = join(homedir(), ".pitch", "workspaces");

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function validateWorkspaceName(name: string): string {
  if (!isSafeWorkspaceName(name)) {
    throw new WorkspaceStateError(`Invalid workspace name: ${name}`);
  }

  return name;
}

function workspaceStatePath(name: string, workspacesDir: string): string {
  return join(workspacesDir, `${validateWorkspaceName(name)}.yaml`);
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

function parseWorkspaceRecord(
  rawContent: string,
  filePath: string,
  expectedName?: string,
): WorkspaceRecord {
  let parsed: unknown;

  try {
    parsed = parseYaml(rawContent);
  } catch (err: unknown) {
    throw new WorkspaceStateError(
      `Failed to parse workspace state YAML in ${filePath}: ${String(err)}`,
    );
  }

  const result = WorkspaceRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkspaceStateError(
      `Invalid workspace state in ${filePath}:\n${formatZodIssues(result.error)}`,
    );
  }

  const workspace = result.data;
  if (expectedName !== undefined && workspace.name !== expectedName) {
    throw new WorkspaceStateError(
      `Workspace state name mismatch in ${filePath}: expected ${expectedName}, found ${workspace.name}`,
    );
  }

  return workspace;
}

function validateListOptions(
  options: ListWorkspacesOptions,
): ListWorkspacesOptions {
  const result = ListWorkspacesOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new WorkspaceStateError(
      `Invalid workspace list options:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

function validateWorkspaceRecord(
  workspace: WorkspaceRecord,
  context: string,
): WorkspaceRecord {
  const result = WorkspaceRecordSchema.safeParse(workspace);
  if (!result.success) {
    throw new WorkspaceStateError(
      `Invalid workspace state in ${context}:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

export async function ensureWorkspacesDir(
  workspacesDir: string = DEFAULT_WORKSPACES_DIR,
): Promise<string> {
  try {
    await mkdir(workspacesDir, { recursive: true });
  } catch (err: unknown) {
    throw new WorkspaceStateError(
      `Failed to create workspace state directory at ${workspacesDir}: ${String(err)}`,
    );
  }

  return workspacesDir;
}

export async function writeWorkspaceRecord(
  workspace: WorkspaceRecord,
  workspacesDir: string = DEFAULT_WORKSPACES_DIR,
): Promise<WorkspaceRecord> {
  await ensureWorkspacesDir(workspacesDir);

  const validated = validateWorkspaceRecord(workspace, "workspace record");
  const filePath = workspaceStatePath(validated.name, workspacesDir);

  try {
    await writeFile(filePath, stringifyYaml(validated), "utf-8");
  } catch (err: unknown) {
    throw new WorkspaceStateError(
      `Failed to write workspace state to ${filePath}: ${String(err)}`,
    );
  }

  return validated;
}

export async function readWorkspaceRecord(
  name: string,
  workspacesDir: string = DEFAULT_WORKSPACES_DIR,
): Promise<WorkspaceRecord | null> {
  const validatedName = validateWorkspaceName(name);
  const filePath = workspaceStatePath(validatedName, workspacesDir);
  let rawContent: string;

  try {
    rawContent = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }

    throw new WorkspaceStateError(
      `Failed to read workspace state at ${filePath}: ${String(err)}`,
    );
  }

  return parseWorkspaceRecord(rawContent, filePath, validatedName);
}

export async function listWorkspaceRecords(
  options: ListWorkspacesOptions = {},
  workspacesDir: string = DEFAULT_WORKSPACES_DIR,
): Promise<WorkspaceRecord[]> {
  const validatedOptions = validateListOptions(options);
  await ensureWorkspacesDir(workspacesDir);

  let entries: Dirent[];
  try {
    entries = await readdir(workspacesDir, { withFileTypes: true });
  } catch (err: unknown) {
    throw new WorkspaceStateError(
      `Failed to list workspace state directory at ${workspacesDir}: ${String(err)}`,
    );
  }

  const yamlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .sort((left, right) => left.name.localeCompare(right.name));

  const workspaces = await Promise.all(
    yamlFiles.map(async (entry) => {
      const expectedName = entry.name.slice(0, -".yaml".length);
      const filePath = join(workspacesDir, entry.name);
      let rawContent: string;

      try {
        rawContent = await readFile(filePath, "utf-8");
      } catch (err: unknown) {
        throw new WorkspaceStateError(
          `Failed to read workspace state at ${filePath}: ${String(err)}`,
        );
      }

      return parseWorkspaceRecord(rawContent, filePath, expectedName);
    }),
  );

  return workspaces.filter((workspace) => {
    if (
      validatedOptions.status !== undefined &&
      validatedOptions.status !== "all" &&
      workspace.status !== validatedOptions.status
    ) {
      return false;
    }

    if (
      validatedOptions.repo !== undefined &&
      workspace.repo !== validatedOptions.repo
    ) {
      return false;
    }

    return true;
  });
}

export async function updateWorkspaceRecord(
  name: string,
  update: (workspace: WorkspaceRecord) => WorkspaceRecord,
  workspacesDir: string = DEFAULT_WORKSPACES_DIR,
): Promise<WorkspaceRecord> {
  const existing = await readWorkspaceRecord(name, workspacesDir);
  if (existing === null) {
    throw new WorkspaceStateError(
      `Workspace state not found for ${validateWorkspaceName(name)}`,
    );
  }

  const updated = update(existing);
  if (updated.name !== existing.name) {
    throw new WorkspaceStateError(
      `Workspace state name cannot change during update: ${existing.name}`,
    );
  }

  return writeWorkspaceRecord(updated, workspacesDir);
}

export async function deleteWorkspaceRecord(
  name: string,
  workspacesDir: string = DEFAULT_WORKSPACES_DIR,
): Promise<boolean> {
  const filePath = workspaceStatePath(name, workspacesDir);

  try {
    await unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return false;
    }

    throw new WorkspaceStateError(
      `Failed to delete workspace state at ${filePath}: ${String(err)}`,
    );
  }
}
