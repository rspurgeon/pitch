import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentSession } from "./workspace-state.js";

const defaultExecFileAsync = promisify(execFile);

export interface CodexThreadTitle {
  session_id: string;
  title: string;
}

export interface SyncCodexThreadTitlesInput {
  workspace_name: string;
  agent_sessions: AgentSession[];
  agent_env: Record<string, string>;
  active_session_id?: string;
  now?: Date;
}

export interface SyncCodexThreadTitlesResult {
  updated: CodexThreadTitle[];
  warnings: string[];
}

interface SyncCodexThreadTitlesDependencies {
  execFileAsync?: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

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

function resolveCodexHome(agentEnv: Record<string, string>): string {
  return expandShellPath(agentEnv.CODEX_HOME ?? "~/.codex");
}

function isConcreteSessionId(sessionId: string): boolean {
  return sessionId !== "pending" && sessionId.trim().length > 0;
}

export function computeCodexThreadTitles(
  workspaceName: string,
  agentSessions: AgentSession[],
  activeSessionId?: string,
): CodexThreadTitle[] {
  const latestSessionId =
    activeSessionId !== undefined && isConcreteSessionId(activeSessionId)
      ? activeSessionId
      : [...agentSessions]
          .reverse()
          .find((session) => isConcreteSessionId(session.id))?.id;

  if (latestSessionId === undefined) {
    return [];
  }

  const titles: CodexThreadTitle[] = [
    {
      session_id: latestSessionId,
      title: workspaceName,
    },
  ];
  const seenSessionIds = new Set([latestSessionId]);

  for (let index = agentSessions.length - 1; index >= 0; index -= 1) {
    const sessionId = agentSessions[index]?.id;
    if (
      sessionId === undefined ||
      !isConcreteSessionId(sessionId) ||
      seenSessionIds.has(sessionId)
    ) {
      continue;
    }

    seenSessionIds.add(sessionId);
    titles.push({
      session_id: sessionId,
      title: `${workspaceName} - ${titles.length}`,
    });
  }

  return titles;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildSqliteTitleUpdate(titles: CodexThreadTitle[]): string {
  const cases = titles
    .map(
      (title) =>
        `WHEN ${sqlStringLiteral(title.session_id)} THEN ${sqlStringLiteral(title.title)}`,
    )
    .join(" ");
  const sessionIds = titles
    .map((title) => sqlStringLiteral(title.session_id))
    .join(", ");

  return [
    "BEGIN IMMEDIATE;",
    `UPDATE threads SET title = CASE id ${cases} ELSE title END WHERE id IN (${sessionIds});`,
    "COMMIT;",
  ].join("\n");
}

async function resolveCodexStateDbPath(codexHome: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(codexHome, { withFileTypes: true });
  } catch {
    return join(codexHome, "state_5.sqlite");
  }

  const stateDbs = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = /^state_(\d+)\.sqlite$/.exec(entry.name);
      if (match === null) {
        return null;
      }

      return {
        name: entry.name,
        version: Number(match[1]),
      };
    })
    .filter((entry): entry is { name: string; version: number } => entry !== null)
    .sort((left, right) => right.version - left.version);

  return join(codexHome, stateDbs[0]?.name ?? "state_5.sqlite");
}

async function appendLegacySessionIndex(
  codexHome: string,
  titles: CodexThreadTitle[],
  input: SyncCodexThreadTitlesInput,
  now: Date,
): Promise<void> {
  const indexPath = join(codexHome, "session_index.jsonl");
  await mkdir(dirname(indexPath), { recursive: true });
  const lines = titles
    .map((title) => {
      const isActiveSession = title.session_id === titles[0]?.session_id;
      const matchingSession = [...input.agent_sessions]
        .reverse()
        .find((session) => session.id === title.session_id);
      const fallbackUpdatedAt = isActiveSession
        ? now.toISOString()
        : matchingSession?.started_at ?? now.toISOString();

      return JSON.stringify({
        id: title.session_id,
        thread_name: title.title,
        updated_at: fallbackUpdatedAt,
      });
    })
    .join("\n");
  await appendFile(indexPath, `${lines}\n`, "utf8");
}

async function updateSqliteThreadTitles(
  codexHome: string,
  titles: CodexThreadTitle[],
  dependencies: Required<SyncCodexThreadTitlesDependencies>,
): Promise<void> {
  const stateDbPath = await resolveCodexStateDbPath(codexHome);
  await dependencies.execFileAsync("sqlite3", [
    stateDbPath,
    buildSqliteTitleUpdate(titles),
  ]);
}

export async function syncCodexThreadTitles(
  input: SyncCodexThreadTitlesInput,
  dependencies: SyncCodexThreadTitlesDependencies = {},
): Promise<SyncCodexThreadTitlesResult> {
  const titles = computeCodexThreadTitles(
    input.workspace_name,
    input.agent_sessions,
    input.active_session_id,
  );
  if (titles.length === 0) {
    return {
      updated: [],
      warnings: [],
    };
  }

  const resolvedDependencies = {
    execFileAsync: dependencies.execFileAsync ?? defaultExecFileAsync,
  };
  const codexHome = resolveCodexHome(input.agent_env);
  const warnings: string[] = [];
  const now = input.now ?? new Date();

  try {
    await updateSqliteThreadTitles(codexHome, titles, resolvedDependencies);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to update Codex thread titles in SQLite: ${message}`);
  }

  try {
    await appendLegacySessionIndex(codexHome, titles, input, now);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to update Codex legacy session index: ${message}`);
  }

  return {
    updated: titles,
    warnings,
  };
}
