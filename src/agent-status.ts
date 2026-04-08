import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readlink,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const AgentRuntimeStateSchema = z.enum([
  "running",
  "question",
  "idle",
  "error",
]);

export const AgentTypeSchema = z.enum(["codex", "claude"]);

export const CodexSessionStateSchema = z.object({
  session_id: z.string(),
  agent_type: z.literal("codex"),
  state: AgentRuntimeStateSchema,
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  tty: z.string().optional(),
  tmux_session: z.string().optional(),
  tmux_window: z.string().optional(),
  tmux_pane_id: z.string().optional(),
  tmux_pane_index: z.number().int().nonnegative().optional(),
  last_event: z.string(),
  last_assistant_message: z.string().optional(),
  error_message: z.string().optional(),
  updated_at: z.string(),
}).strict();

export const ClaudeSessionStateSchema = z.object({
  session_id: z.string(),
  agent_type: z.literal("claude"),
  state: AgentRuntimeStateSchema,
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  tty: z.string().optional(),
  tmux_session: z.string().optional(),
  tmux_window: z.string().optional(),
  tmux_pane_id: z.string().optional(),
  tmux_pane_index: z.number().int().nonnegative().optional(),
  last_event: z.string(),
  last_notification_message: z.string().optional(),
  last_stop_message: z.string().optional(),
  error_message: z.string().optional(),
  updated_at: z.string(),
}).strict();

export const AgentSessionStateSchema = z.discriminatedUnion("agent_type", [
  CodexSessionStateSchema,
  ClaudeSessionStateSchema,
]);

const SummaryCountsSchema = z.object({
  running: z.number().int().nonnegative(),
  question: z.number().int().nonnegative(),
  idle: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
}).strict();

export const AgentStatusSummarySchema = z.object({
  generated_at: z.string(),
  active_sessions: z.number().int().nonnegative(),
  counts: SummaryCountsSchema,
}).strict();

export const AgentStatusSnapshotSchema = z.object({
  summary: AgentStatusSummarySchema,
  sessions: z.array(AgentSessionStateSchema),
}).strict();

export const CodexHookPayloadSchema = z.object({
  hook_event_name: z.string(),
  session_id: z.string(),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  tty: z.string().optional(),
  last_assistant_message: z.string().optional(),
}).passthrough();

export const ClaudeHookPayloadSchema = z.object({
  hook_event_name: z.string(),
  session_id: z.string(),
  cwd: z.string().optional(),
  transcript_path: z.string().optional(),
  tty: z.string().optional(),
  message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
}).passthrough();

export type AgentRuntimeState = z.infer<typeof AgentRuntimeStateSchema>;
export type AgentType = z.infer<typeof AgentTypeSchema>;
export type CodexSessionState = z.infer<typeof CodexSessionStateSchema>;
export type ClaudeSessionState = z.infer<typeof ClaudeSessionStateSchema>;
export type AgentSessionState = z.infer<typeof AgentSessionStateSchema>;
export type AgentStatusSummary = z.infer<typeof AgentStatusSummarySchema>;
export type AgentStatusSnapshot = z.infer<typeof AgentStatusSnapshotSchema>;
export type CodexHookPayload = z.infer<typeof CodexHookPayloadSchema>;
export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayloadSchema>;

export interface ActiveAgentProcess {
  agent_type?: AgentType;
  pid: number;
  tty?: string;
  cwd?: string;
}

export interface CurrentTmuxContext {
  session_name: string;
  window_name: string;
  pane_id: string;
  pane_index: number;
  pane_tty?: string;
}

export const DEFAULT_AGENT_STATUS_DIR = join(
  process.env.PITCH_AGENT_STATUS_DIR ??
    join(homedir(), ".cache", "agent-status"),
);
export const DEFAULT_STALE_SESSION_RETENTION_MS = 30 * 60 * 1000;

function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function decodeSessionId(sessionId: string): string {
  return decodeURIComponent(sessionId);
}

export function getCodexSessionsDir(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): string {
  return join(cacheDir, "codex", "sessions");
}

export function getClaudeSessionsDir(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): string {
  return join(cacheDir, "claude", "sessions");
}

export function getCodexSessionStatePath(
  sessionId: string,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): string {
  return join(getCodexSessionsDir(cacheDir), `${encodeSessionId(sessionId)}.json`);
}

export function getClaudeSessionStatePath(
  sessionId: string,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): string {
  return join(getClaudeSessionsDir(cacheDir), `${encodeSessionId(sessionId)}.json`);
}

export function getAgentStatusSummaryPath(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): string {
  return join(cacheDir, "summary.json");
}

function normalizeTty(tty: string | undefined): string | undefined {
  if (tty === undefined) {
    return undefined;
  }

  const trimmed = tty.trim();
  if (trimmed.length === 0 || trimmed === "not a tty") {
    return undefined;
  }

  return trimmed.startsWith("/dev/") ? trimmed.slice(5) : trimmed;
}

function isQuestionLikeMessage(message: string | undefined): boolean {
  if (message === undefined) {
    return false;
  }

  const normalized = message.trim();
  if (normalized.length === 0) {
    return false;
  }

  return /(?:\bdo you want me to\b|\bwould you like me to\b|\bif you want me to\b|\bplease confirm\b|\bi need your approval\b|\bi need permission\b|\bwaiting for your approval\b|\bwaiting for your confirmation\b|\bwhich option should i\b|\blet me know which\b)/i.test(
    normalized,
  );
}

function isClaudeAttentionMessage(message: string | undefined): boolean {
  if (message === undefined) {
    return false;
  }

  const normalized = message.trim();
  if (normalized.length === 0) {
    return false;
  }

  if (isQuestionLikeMessage(normalized)) {
    return true;
  }

  return /(?:\bshall i\b|\bshould i\b|\bwhich, if any,\b|\blet me know which\b|\bwhich would you like\b|\bwhich one would you like\b|\bwould you like me to proceed\b|\bask for your approval\b|\bawaiting your approval\b)/i.test(
    normalized,
  );
}

function extractTextFromClaudeContentNode(node: unknown): string[] {
  if (typeof node === "string") {
    const trimmed = node.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((item) => extractTextFromClaudeContentNode(item));
  }

  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;

    if (record.type === "text" && typeof record.text === "string") {
      const trimmed = record.text.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }

    if (record.message !== undefined) {
      return extractTextFromClaudeContentNode(record.message);
    }

    if (record.content !== undefined) {
      return extractTextFromClaudeContentNode(record.content);
    }
  }

  return [];
}

function extractAssistantTextFromClaudeTranscriptEntry(
  entry: unknown,
): string | undefined {
  if (entry === null || typeof entry !== "object") {
    return undefined;
  }

  const record = entry as Record<string, unknown>;
  const role =
    typeof record.role === "string"
      ? record.role
      : record.message !== null &&
          typeof record.message === "object" &&
          typeof (record.message as Record<string, unknown>).role === "string"
        ? ((record.message as Record<string, unknown>).role as string)
        : undefined;

  if (role !== "assistant") {
    return undefined;
  }

  const textParts = extractTextFromClaudeContentNode(record);
  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n");
}

async function readClaudeStopMessageFromTranscript(
  transcriptPath: string | undefined,
): Promise<string | undefined> {
  if (transcriptPath === undefined) {
    return undefined;
  }

  try {
    const raw = await readFile(transcriptPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      try {
        const parsed = JSON.parse(line);
        const assistantText = extractAssistantTextFromClaudeTranscriptEntry(parsed);
        if (assistantText !== undefined) {
          return assistantText;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function deriveStateFromHookEvent(
  payload: CodexHookPayload,
): AgentRuntimeState {
  switch (payload.hook_event_name) {
    case "SessionStart":
      return "idle";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "running";
    case "Stop":
      return isQuestionLikeMessage(payload.last_assistant_message)
        ? "question"
        : "idle";
    default:
      return "idle";
  }
}

export async function getCurrentTty(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("tty", []);
    return normalizeTty(stdout);
  } catch {
    return undefined;
  }
}

export async function getCurrentTmuxContext(): Promise<CurrentTmuxContext | undefined> {
  const paneId = process.env.TMUX_PANE;
  if (paneId === undefined || paneId.trim().length === 0) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_index}\t#{pane_tty}",
    ]);
    const [
      sessionName,
      windowName,
      resolvedPaneId,
      paneIndexText,
      paneTty,
    ] = stdout.trimEnd().split("\t");
    const paneIndex = Number.parseInt(paneIndexText ?? "", 10);

    if (
      sessionName === undefined ||
      windowName === undefined ||
      resolvedPaneId === undefined ||
      !Number.isSafeInteger(paneIndex)
    ) {
      return undefined;
    }

    return {
      session_name: sessionName,
      window_name: windowName,
      pane_id: resolvedPaneId,
      pane_index: paneIndex,
      pane_tty: normalizeTty(paneTty),
    };
  } catch {
    return undefined;
  }
}

export async function ensureAgentStatusDir(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<string> {
  await mkdir(getCodexSessionsDir(cacheDir), { recursive: true });
  await mkdir(getClaudeSessionsDir(cacheDir), { recursive: true });
  return cacheDir;
}

export async function readCodexSessionState(
  sessionId: string,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<CodexSessionState | null> {
  try {
    const raw = await readFile(getCodexSessionStatePath(sessionId, cacheDir), "utf8");
    return CodexSessionStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function listCodexSessionStates(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<CodexSessionState[]> {
  try {
    const entries = await readdir(getCodexSessionsDir(cacheDir), {
      withFileTypes: true,
    });

    const sessionStates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const sessionId = decodeSessionId(entry.name.slice(0, -".json".length));
          return readCodexSessionState(sessionId, cacheDir);
        }),
    );

    return sessionStates.filter((state): state is CodexSessionState => state !== null);
  } catch {
    return [];
  }
}

export async function readClaudeSessionState(
  sessionId: string,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<ClaudeSessionState | null> {
  try {
    const raw = await readFile(getClaudeSessionStatePath(sessionId, cacheDir), "utf8");
    return ClaudeSessionStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function listClaudeSessionStates(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<ClaudeSessionState[]> {
  try {
    const entries = await readdir(getClaudeSessionsDir(cacheDir), {
      withFileTypes: true,
    });

    const sessionStates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const sessionId = decodeSessionId(entry.name.slice(0, -".json".length));
          return readClaudeSessionState(sessionId, cacheDir);
        }),
    );

    return sessionStates.filter((state): state is ClaudeSessionState => state !== null);
  } catch {
    return [];
  }
}

export async function writeCodexSessionState(
  state: CodexSessionState,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<CodexSessionState> {
  await ensureAgentStatusDir(cacheDir);
  const validated = CodexSessionStateSchema.parse(state);
  await writeFile(
    getCodexSessionStatePath(validated.session_id, cacheDir),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
  return validated;
}

export async function writeClaudeSessionState(
  state: ClaudeSessionState,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<ClaudeSessionState> {
  await ensureAgentStatusDir(cacheDir);
  const validated = ClaudeSessionStateSchema.parse(state);
  await writeFile(
    getClaudeSessionStatePath(validated.session_id, cacheDir),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
  return validated;
}

async function listActiveProcessesByCommand(
  commandName: AgentType,
): Promise<ActiveAgentProcess[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,tty=,comm="]);
    const activeProcesses: ActiveAgentProcess[] = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const parts = trimmed.split(/\s+/, 3);
      const pid = Number.parseInt(parts[0] ?? "", 10);
      const tty = normalizeTty(parts[1]);
      const command = parts[2];
      if (!Number.isFinite(pid) || command !== commandName) {
        continue;
      }

      let cwd: string | undefined;
      try {
        cwd = await readlink(`/proc/${pid}/cwd`);
      } catch {
        cwd = undefined;
      }

      activeProcesses.push({
        agent_type: commandName,
        pid,
        tty,
        cwd,
      });
    }

    return activeProcesses;
  } catch {
    return [];
  }
}

export async function listActiveCodexProcesses(): Promise<ActiveAgentProcess[]> {
  return listActiveProcessesByCommand("codex");
}

export async function listActiveClaudeProcesses(): Promise<ActiveAgentProcess[]> {
  return listActiveProcessesByCommand("claude");
}

export async function listActiveCodexTtys(): Promise<Set<string>> {
  const activeProcesses = await listActiveCodexProcesses();
  return new Set(
    activeProcesses
      .map((processInfo) => processInfo.tty)
      .filter((tty): tty is string => tty !== undefined),
  );
}

function compareUpdatedAtDescending(
  left: { updated_at: string },
  right: { updated_at: string },
): number {
  return right.updated_at.localeCompare(left.updated_at);
}

function isExpiredSessionState(
  sessionState: AgentSessionState,
  now: Date,
  retentionMs: number,
): boolean {
  const updatedAt = Date.parse(sessionState.updated_at);
  if (!Number.isFinite(updatedAt)) {
    return true;
  }

  return now.getTime() - updatedAt > retentionMs;
}

function summarizeStates(
  sessionStates: AgentSessionState[],
  activeProcesses: ActiveAgentProcess[],
  now: Date,
): AgentStatusSummary {
  const latestBySessionId = new Map<string, AgentSessionState>();
  for (const sessionState of [...sessionStates].sort(compareUpdatedAtDescending)) {
    if (!latestBySessionId.has(sessionState.session_id)) {
      latestBySessionId.set(sessionState.session_id, sessionState);
    }
  }

  const activeTtys = new Set<string>();
  const uniqueProcessByCwd = new Map<string, ActiveAgentProcess | null>();
  for (const activeProcess of activeProcesses) {
    const agentType = activeProcess.agent_type ?? "codex";

    if (activeProcess.tty !== undefined) {
      activeTtys.add(`${agentType}:${activeProcess.tty}`);
    }

    if (activeProcess.cwd === undefined) {
      continue;
    }

    const current = uniqueProcessByCwd.get(
      `${agentType}:${activeProcess.cwd}`,
    );
    uniqueProcessByCwd.set(
      `${agentType}:${activeProcess.cwd}`,
      current === undefined ? activeProcess : null,
    );
  }

  const latestByProcessIdentity = new Map<string, AgentSessionState>();
  for (const sessionState of latestBySessionId.values()) {
    const tty = normalizeTty(sessionState.tty);
    let processIdentity: string | undefined;

    if (tty !== undefined && activeTtys.has(`${sessionState.agent_type}:${tty}`)) {
      processIdentity = `${sessionState.agent_type}:tty:${tty}`;
    } else if (sessionState.cwd !== undefined) {
      const matchingProcess = uniqueProcessByCwd.get(
        `${sessionState.agent_type}:${sessionState.cwd}`,
      );
      if (matchingProcess?.tty !== undefined) {
        processIdentity = `${sessionState.agent_type}:tty:${matchingProcess.tty}`;
      } else if (matchingProcess !== undefined && matchingProcess !== null) {
        processIdentity = `${sessionState.agent_type}:pid:${matchingProcess.pid}`;
      }
    }

    if (processIdentity === undefined) {
      continue;
    }

    const current = latestByProcessIdentity.get(processIdentity);
    if (
      current === undefined ||
      sessionState.updated_at.localeCompare(current.updated_at) > 0
    ) {
      latestByProcessIdentity.set(processIdentity, sessionState);
    }
  }

  const counts = {
    running: 0,
    question: 0,
    idle: 0,
    error: 0,
  };

  for (const sessionState of latestByProcessIdentity.values()) {
    counts[sessionState.state] += 1;
  }

  return {
    generated_at: now.toISOString(),
    active_sessions: latestByProcessIdentity.size,
    counts,
  };
}

export async function readAgentStatusSummary(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<AgentStatusSummary | null> {
  try {
    const raw = await readFile(getAgentStatusSummaryPath(cacheDir), "utf8");
    return AgentStatusSummarySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeAgentStatusSummary(
  summary: AgentStatusSummary,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<AgentStatusSummary> {
  await mkdir(cacheDir, { recursive: true });
  const validated = AgentStatusSummarySchema.parse(summary);
  await writeFile(
    getAgentStatusSummaryPath(cacheDir),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
  return validated;
}

export async function deleteCodexSessionState(
  sessionId: string,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<void> {
  try {
    await unlink(getCodexSessionStatePath(sessionId, cacheDir));
  } catch {
    return;
  }
}

export async function deleteClaudeSessionState(
  sessionId: string,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
): Promise<void> {
  try {
    await unlink(getClaudeSessionStatePath(sessionId, cacheDir));
  } catch {
    return;
  }
}

export interface AgentStatusDependencies {
  getCurrentTty: typeof getCurrentTty;
  getCurrentTmuxContext: typeof getCurrentTmuxContext;
  readCodexSessionState: typeof readCodexSessionState;
  writeCodexSessionState: typeof writeCodexSessionState;
  deleteCodexSessionState: typeof deleteCodexSessionState;
  listCodexSessionStates: typeof listCodexSessionStates;
  listActiveCodexProcesses: typeof listActiveCodexProcesses;
  readClaudeSessionState: typeof readClaudeSessionState;
  writeClaudeSessionState: typeof writeClaudeSessionState;
  deleteClaudeSessionState: typeof deleteClaudeSessionState;
  listClaudeSessionStates: typeof listClaudeSessionStates;
  listActiveClaudeProcesses: typeof listActiveClaudeProcesses;
  writeAgentStatusSummary: typeof writeAgentStatusSummary;
  now: () => Date;
}

interface CollectedAgentStatusState {
  summary: AgentStatusSummary;
  freshSessionStates: AgentSessionState[];
}

const defaultDependencies: AgentStatusDependencies = {
  getCurrentTty,
  getCurrentTmuxContext,
  readCodexSessionState,
  writeCodexSessionState,
  deleteCodexSessionState,
  listCodexSessionStates,
  listActiveCodexProcesses,
  readClaudeSessionState,
  writeClaudeSessionState,
  deleteClaudeSessionState,
  listClaudeSessionStates,
  listActiveClaudeProcesses,
  writeAgentStatusSummary,
  now: () => new Date(),
};

export async function handleCodexHookPayload(
  payload: CodexHookPayload,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
  dependencyOverrides: Partial<AgentStatusDependencies> = {},
): Promise<CodexSessionState> {
  const dependencies: AgentStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const validatedPayload = CodexHookPayloadSchema.parse(payload);
  const existing = await dependencies.readCodexSessionState(
    validatedPayload.session_id,
    cacheDir,
  );
  const tty =
    normalizeTty(validatedPayload.tty) ??
    await dependencies.getCurrentTty();
  const tmuxContext = await dependencies.getCurrentTmuxContext();

  const nextState: CodexSessionState = {
    session_id: validatedPayload.session_id,
    agent_type: "codex",
    state: deriveStateFromHookEvent(validatedPayload),
    cwd: validatedPayload.cwd ?? existing?.cwd,
    transcript_path:
      validatedPayload.transcript_path ?? existing?.transcript_path,
    tty: tty ?? tmuxContext?.pane_tty ?? existing?.tty,
    tmux_session: tmuxContext?.session_name ?? existing?.tmux_session,
    tmux_window: tmuxContext?.window_name ?? existing?.tmux_window,
    tmux_pane_id: tmuxContext?.pane_id ?? existing?.tmux_pane_id,
    tmux_pane_index: tmuxContext?.pane_index ?? existing?.tmux_pane_index,
    last_event: validatedPayload.hook_event_name,
    last_assistant_message:
      validatedPayload.last_assistant_message ??
      existing?.last_assistant_message,
    error_message: undefined,
    updated_at: dependencies.now().toISOString(),
  };

  const written = await dependencies.writeCodexSessionState(nextState, cacheDir);
  await refreshAgentStatusSummary(cacheDir, dependencyOverrides);
  return written;
}

function deriveStateFromClaudeHookEvent(
  payload: ClaudeHookPayload,
): AgentRuntimeState {
  switch (payload.hook_event_name) {
    case "Notification":
      return "question";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "running";
    case "SessionStart":
    case "SessionEnd":
      return "idle";
    case "Stop":
      return isClaudeAttentionMessage(payload.message) ? "question" : "idle";
    default:
      return "idle";
  }
}

export async function handleClaudeHookPayload(
  payload: ClaudeHookPayload,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
  dependencyOverrides: Partial<AgentStatusDependencies> = {},
): Promise<ClaudeSessionState> {
  const dependencies: AgentStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const validatedPayload = ClaudeHookPayloadSchema.parse(payload);
  const existing = await dependencies.readClaudeSessionState(
    validatedPayload.session_id,
    cacheDir,
  );
  const stopMessage =
    validatedPayload.hook_event_name === "Stop"
      ? validatedPayload.message ??
        (await readClaudeStopMessageFromTranscript(
          validatedPayload.transcript_path ?? existing?.transcript_path,
        ))
      : undefined;
  const tty =
    normalizeTty(validatedPayload.tty) ??
    await dependencies.getCurrentTty();
  const tmuxContext = await dependencies.getCurrentTmuxContext();

  const nextState: ClaudeSessionState = {
    session_id: validatedPayload.session_id,
    agent_type: "claude",
    state: deriveStateFromClaudeHookEvent({
      ...validatedPayload,
      message: stopMessage ?? validatedPayload.message,
    }),
    cwd: validatedPayload.cwd ?? existing?.cwd,
    transcript_path:
      validatedPayload.transcript_path ?? existing?.transcript_path,
    tty: tty ?? tmuxContext?.pane_tty ?? existing?.tty,
    tmux_session: tmuxContext?.session_name ?? existing?.tmux_session,
    tmux_window: tmuxContext?.window_name ?? existing?.tmux_window,
    tmux_pane_id: tmuxContext?.pane_id ?? existing?.tmux_pane_id,
    tmux_pane_index: tmuxContext?.pane_index ?? existing?.tmux_pane_index,
    last_event: validatedPayload.hook_event_name,
    last_notification_message:
      validatedPayload.hook_event_name === "Notification"
        ? validatedPayload.message
        : existing?.last_notification_message,
    last_stop_message:
      validatedPayload.hook_event_name === "Stop"
        ? stopMessage
        : existing?.last_stop_message,
    error_message: undefined,
    updated_at: dependencies.now().toISOString(),
  };

  if (validatedPayload.hook_event_name === "SessionEnd") {
    await dependencies.deleteClaudeSessionState(validatedPayload.session_id, cacheDir);
    await refreshAgentStatusSummary(cacheDir, dependencyOverrides);
    return nextState;
  }

  const written = await dependencies.writeClaudeSessionState(nextState, cacheDir);
  await refreshAgentStatusSummary(cacheDir, dependencyOverrides);
  return written;
}

async function collectAgentStatusState(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
  dependencyOverrides: Partial<AgentStatusDependencies> = {},
): Promise<CollectedAgentStatusState> {
  const dependencies: AgentStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const now = dependencies.now();
  const [codexSessionStates, claudeSessionStates, activeCodexProcesses, activeClaudeProcesses] =
    await Promise.all([
      dependencies.listCodexSessionStates(cacheDir),
      dependencies.listClaudeSessionStates(cacheDir),
      dependencies.listActiveCodexProcesses(),
      dependencies.listActiveClaudeProcesses(),
    ]);
  const sessionStates = [...codexSessionStates, ...claudeSessionStates];
  const activeProcesses = [...activeCodexProcesses, ...activeClaudeProcesses];
  const activeSessionIds = new Set<string>();

  for (const activeProcess of activeProcesses) {
    const agentType = activeProcess.agent_type ?? "codex";
    const tty = normalizeTty(activeProcess.tty);
    if (tty !== undefined) {
      const matchingSessions = sessionStates
        .filter(
          (sessionState) =>
            sessionState.agent_type === agentType &&
            normalizeTty(sessionState.tty) === tty,
        )
        .sort(compareUpdatedAtDescending);
      if (matchingSessions[0] !== undefined) {
        activeSessionIds.add(
          `${matchingSessions[0].agent_type}:${matchingSessions[0].session_id}`,
        );
        continue;
      }
    }

    if (activeProcess.cwd !== undefined) {
      const matchingSessions = sessionStates
        .filter(
          (sessionState) =>
            sessionState.agent_type === agentType &&
            normalizeTty(sessionState.tty) === undefined &&
            sessionState.cwd === activeProcess.cwd,
        )
        .sort(compareUpdatedAtDescending);
      if (matchingSessions.length === 1) {
        activeSessionIds.add(
          `${matchingSessions[0].agent_type}:${matchingSessions[0].session_id}`,
        );
      }
    }
  }

  await Promise.all(
    sessionStates
      .filter(
        (sessionState) =>
          !activeSessionIds.has(
            `${sessionState.agent_type}:${sessionState.session_id}`,
          ) &&
          isExpiredSessionState(
            sessionState,
            now,
            DEFAULT_STALE_SESSION_RETENTION_MS,
          ),
      )
      .map((sessionState) => {
        if (sessionState.agent_type === "claude") {
          return dependencies.deleteClaudeSessionState(
            sessionState.session_id,
            cacheDir,
          );
        }

        return dependencies.deleteCodexSessionState(
          sessionState.session_id,
          cacheDir,
        );
      }),
  );

  const freshSessionStates = sessionStates.filter(
    (sessionState) =>
      activeSessionIds.has(
        `${sessionState.agent_type}:${sessionState.session_id}`,
      ) ||
      !isExpiredSessionState(
        sessionState,
        now,
        DEFAULT_STALE_SESSION_RETENTION_MS,
      ),
  );
  const summary = summarizeStates(freshSessionStates, activeProcesses, now);

  return {
    summary,
    freshSessionStates,
  };
}

export async function refreshAgentStatusSummary(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
  dependencyOverrides: Partial<AgentStatusDependencies> = {},
): Promise<AgentStatusSummary> {
  const dependencies: AgentStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const { summary } = await collectAgentStatusState(cacheDir, dependencyOverrides);
  return dependencies.writeAgentStatusSummary(summary, cacheDir);
}

export interface MarkAgentErrorInput {
  agent_type: AgentType;
  session_id: string;
  message: string;
  cwd?: string;
  transcript_path?: string;
  tty?: string;
}

export async function markAgentSessionError(
  input: MarkAgentErrorInput,
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
  dependencyOverrides: Partial<AgentStatusDependencies> = {},
): Promise<AgentSessionState> {
  const dependencies: AgentStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const updatedAt = dependencies.now().toISOString();
  const normalizedTty = normalizeTty(input.tty);

  if (input.agent_type === "codex") {
    const existing = await dependencies.readCodexSessionState(
      input.session_id,
      cacheDir,
    );
    const nextState: CodexSessionState = {
      session_id: input.session_id,
      agent_type: "codex",
      state: "error",
      cwd: input.cwd ?? existing?.cwd,
      transcript_path: input.transcript_path ?? existing?.transcript_path,
      tty: normalizedTty ?? existing?.tty,
      tmux_session: existing?.tmux_session,
      tmux_window: existing?.tmux_window,
      tmux_pane_id: existing?.tmux_pane_id,
      tmux_pane_index: existing?.tmux_pane_index,
      last_event: "Error",
      last_assistant_message: existing?.last_assistant_message,
      error_message: input.message,
      updated_at: updatedAt,
    };
    const written = await dependencies.writeCodexSessionState(nextState, cacheDir);
    await refreshAgentStatusSummary(cacheDir, dependencyOverrides);
    return written;
  }

  const existing = await dependencies.readClaudeSessionState(
    input.session_id,
    cacheDir,
  );
  const nextState: ClaudeSessionState = {
    session_id: input.session_id,
    agent_type: "claude",
    state: "error",
    cwd: input.cwd ?? existing?.cwd,
    transcript_path: input.transcript_path ?? existing?.transcript_path,
    tty: normalizedTty ?? existing?.tty,
    tmux_session: existing?.tmux_session,
    tmux_window: existing?.tmux_window,
    tmux_pane_id: existing?.tmux_pane_id,
    tmux_pane_index: existing?.tmux_pane_index,
    last_event: "Error",
    last_notification_message: existing?.last_notification_message,
    last_stop_message: existing?.last_stop_message,
    error_message: input.message,
    updated_at: updatedAt,
  };
  const written = await dependencies.writeClaudeSessionState(nextState, cacheDir);
  await refreshAgentStatusSummary(cacheDir, dependencyOverrides);
  return written;
}

export async function getAgentStatusSnapshot(
  cacheDir: string = DEFAULT_AGENT_STATUS_DIR,
  dependencyOverrides: Partial<AgentStatusDependencies> = {},
): Promise<AgentStatusSnapshot> {
  const dependencies: AgentStatusDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  const { summary, freshSessionStates } = await collectAgentStatusState(
    cacheDir,
    dependencyOverrides,
  );
  await dependencies.writeAgentStatusSummary(summary, cacheDir);

  return AgentStatusSnapshotSchema.parse({
    summary,
    sessions: [...freshSessionStates].sort(compareUpdatedAtDescending),
  });
}
