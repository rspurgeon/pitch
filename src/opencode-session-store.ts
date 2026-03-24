import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface OpencodeSessionLookupInput {
  worktree_path: string;
  started_at: string;
  agent_env: Record<string, string>;
  now?: Date;
}

export interface OpencodeSessionMeta {
  id: string;
  directory: string;
  created_at: string;
  file_path: string;
}

const SESSION_CLOCK_SKEW_MS = 60_000;

const SessionFileSchema = z
  .object({
    id: z.string().min(1),
    directory: z.string().min(1),
    time: z.object({
      created: z.number().finite(),
    }).passthrough(),
  })
  .passthrough();

function expandShellPath(path: string): string {
  let expanded = path;

  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = join(homedir(), expanded.slice(2));
  }

  return expanded.replace(/\$(\w+)|\$\{([^}]+)\}/g, (match, simple, wrapped) => {
    const key = simple ?? wrapped;
    const value = process.env[key];
    return value ?? match;
  });
}

function resolveOpencodeSessionsRoot(agentEnv: Record<string, string>): string {
  const xdgDataHome =
    agentEnv.XDG_DATA_HOME ??
    process.env.XDG_DATA_HOME ??
    "~/.local/share";

  return join(expandShellPath(xdgDataHome), "opencode", "storage", "session");
}

async function readSessionMeta(
  filePath: string,
): Promise<OpencodeSessionMeta | null> {
  let rawContent: string;
  try {
    rawContent = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return null;
  }

  const result = SessionFileSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return {
    id: result.data.id,
    directory: result.data.directory,
    created_at: new Date(result.data.time.created).toISOString(),
    file_path: filePath,
  };
}

export async function findOpencodeSessionForWorkspace(
  input: OpencodeSessionLookupInput,
): Promise<OpencodeSessionMeta | null> {
  const startedAt = new Date(input.started_at);
  if (Number.isNaN(startedAt.getTime())) {
    return null;
  }

  const now = input.now ?? new Date();
  const sessionsRoot = resolveOpencodeSessionsRoot(input.agent_env);

  let projectDirectories;
  try {
    projectDirectories = await readdir(sessionsRoot, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch {
    return null;
  }

  const matches: OpencodeSessionMeta[] = [];

  for (const projectDirectory of projectDirectories
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const sessionDirectory = join(sessionsRoot, projectDirectory.name);

    let sessionFiles;
    try {
      sessionFiles = await readdir(sessionDirectory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      continue;
    }

    for (const sessionFile of sessionFiles
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = join(sessionDirectory, sessionFile.name);
      const meta = await readSessionMeta(filePath);
      if (meta === null || meta.directory !== input.worktree_path) {
        continue;
      }

      const createdAt = new Date(meta.created_at);
      if (Number.isNaN(createdAt.getTime())) {
        continue;
      }

      if (
        createdAt.getTime() <
          startedAt.getTime() - SESSION_CLOCK_SKEW_MS ||
        createdAt.getTime() > now.getTime() + SESSION_CLOCK_SKEW_MS
      ) {
        continue;
      }

      matches.push(meta);
    }
  }

  matches.sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();
    return leftTime - rightTime || left.file_path.localeCompare(right.file_path);
  });

  return matches[0] ?? null;
}
