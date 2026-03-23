import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export interface CodexSessionLookupInput {
  worktree_path: string;
  started_at: string;
  agent_env: Record<string, string>;
  now?: Date;
}

export interface CodexSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  file_path: string;
}

const SESSION_META_CLOCK_SKEW_MS = 60_000;
const MAX_SESSION_META_LINE_BYTES = 64 * 1024;
const SESSION_META_READ_CHUNK_SIZE = 4096;

const SessionMetaLineSchema = z
  .object({
    type: z.literal("session_meta"),
    payload: z.object({
      id: z.string().min(1),
      timestamp: z.string().min(1),
      cwd: z.string().min(1),
    }),
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

function resolveCodexSessionsRoot(agentEnv: Record<string, string>): string {
  const codexHome = agentEnv.CODEX_HOME ?? "~/.codex";
  return join(expandShellPath(codexHome), "sessions");
}

function parseSessionMetaLine(
  firstLine: string,
  filePath: string,
): CodexSessionMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return null;
  }

  const result = SessionMetaLineSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return {
    id: result.data.payload.id,
    timestamp: result.data.payload.timestamp,
    cwd: result.data.payload.cwd,
    file_path: filePath,
  };
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await open(filePath, "r");

  try {
    let position = 0;
    let line = "";

    while (line.length < MAX_SESSION_META_LINE_BYTES) {
      const remainingBytes = MAX_SESSION_META_LINE_BYTES - line.length;
      const buffer = Buffer.alloc(
        Math.min(SESSION_META_READ_CHUNK_SIZE, remainingBytes),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);

      if (bytesRead === 0) {
        break;
      }

      const chunk = buffer.toString("utf8", 0, bytesRead);
      const newlineIndex = chunk.indexOf("\n");

      if (newlineIndex !== -1) {
        line += chunk.slice(0, newlineIndex);
        break;
      }

      line += chunk;
      position += bytesRead;
    }

    const trimmed = line.replace(/\r$/, "").trim();
    return trimmed.length === 0 ? null : trimmed;
  } finally {
    await handle.close();
  }
}

function* enumerateSearchDates(
  startedAt: Date,
  now: Date,
): Generator<string> {
  const current = new Date(startedAt);
  current.setUTCDate(current.getUTCDate() - 1);
  current.setUTCHours(0, 0, 0, 0);

  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);

  while (current.getTime() <= end.getTime()) {
    const year = current.getUTCFullYear().toString();
    const month = String(current.getUTCMonth() + 1).padStart(2, "0");
    const day = String(current.getUTCDate()).padStart(2, "0");

    yield join(year, month, day);
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

export async function findCodexSessionForWorkspace(
  input: CodexSessionLookupInput,
): Promise<CodexSessionMeta | null> {
  const startedAt = new Date(input.started_at);
  if (Number.isNaN(startedAt.getTime())) {
    return null;
  }

  const now = input.now ?? new Date();
  const sessionsRoot = resolveCodexSessionsRoot(input.agent_env);

  for (const relativeDatePath of enumerateSearchDates(startedAt, now)) {
    const dayDirectory = join(sessionsRoot, relativeDatePath);

    let entries;
    try {
      entries = await readdir(dayDirectory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      continue;
    }

    const rolloutFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dayDirectory, entry.name))
      .sort();
    const dayMatches: CodexSessionMeta[] = [];

    for (const filePath of rolloutFiles) {
      let firstLine: string | null;
      try {
        firstLine = await readFirstLine(filePath);
      } catch {
        continue;
      }

      if (firstLine === null) {
        continue;
      }

      const meta = parseSessionMetaLine(firstLine, filePath);
      if (meta === null || meta.cwd !== input.worktree_path) {
        continue;
      }

      const sessionTime = new Date(meta.timestamp);
      if (Number.isNaN(sessionTime.getTime())) {
        continue;
      }

      if (
        sessionTime.getTime() <
        startedAt.getTime() - SESSION_META_CLOCK_SKEW_MS
      ) {
        continue;
      }

      dayMatches.push(meta);
    }

    dayMatches.sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime();
      const rightTime = new Date(right.timestamp).getTime();
      return (
        leftTime - rightTime || left.file_path.localeCompare(right.file_path)
      );
    });

    if (dayMatches.length > 0) {
      return dayMatches[0] ?? null;
    }
  }

  return null;
}
