import { readdir, readFile } from "node:fs/promises";
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
  rawContent: string,
  filePath: string,
): CodexSessionMeta | null {
  const firstLine = rawContent.split("\n", 1)[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) {
    return null;
  }

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
  const matches: CodexSessionMeta[] = [];

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

    for (const filePath of rolloutFiles) {
      let rawContent: string;
      try {
        rawContent = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      const meta = parseSessionMetaLine(rawContent, filePath);
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

      matches.push(meta);
    }
  }

  matches.sort((left, right) => {
    const leftTime = new Date(left.timestamp).getTime();
    const rightTime = new Date(right.timestamp).getTime();
    return leftTime - rightTime || left.file_path.localeCompare(right.file_path);
  });

  return matches[0] ?? null;
}
