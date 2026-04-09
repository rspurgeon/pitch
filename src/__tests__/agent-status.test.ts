import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  getAgentStatusSnapshot,
  getAgentStatusSummaryPath,
  handleClaudeHookPayload,
  handleCodexHookPayload,
  listClaudeSessionStates,
  listCodexSessionStates,
  refreshAgentStatusSummary,
  writeAgentStatusSummary,
  writeClaudeSessionState,
  writeCodexSessionState,
  type ClaudeSessionState,
  type CodexSessionState,
} from "../agent-status.js";
import { resolveVmSharedAgentStatusPaths } from "../execution-environment.js";

async function makeTempCacheDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pitch-agent-status-"));
}

function makeSessionState(
  overrides: Partial<CodexSessionState> = {},
): CodexSessionState {
  return {
    session_id: "session-1",
    agent_type: "codex",
    state: "idle",
    cwd: "/tmp/worktrees/demo",
    transcript_path: "/tmp/transcripts/demo.jsonl",
    tty: "pts/21",
    tmux_session: "pitch",
    tmux_window: "tmux-sidebar",
    tmux_pane_id: "%12",
    tmux_pane_index: 0,
    last_event: "Stop",
    last_assistant_message: "Done.",
    updated_at: "2026-04-08T12:00:00.000Z",
    ...overrides,
  };
}

function makeClaudeSessionState(
  overrides: Partial<ClaudeSessionState> = {},
): ClaudeSessionState {
  return {
    session_id: "claude-session-1",
    agent_type: "claude",
    state: "idle",
    cwd: "/tmp/worktrees/claude-demo",
    transcript_path: "/tmp/transcripts/claude-demo.jsonl",
    tty: "pts/31",
    tmux_session: "pitch",
    tmux_window: "tmux-sidebar",
    tmux_pane_id: "%31",
    tmux_pane_index: 0,
    last_event: "Stop",
    last_notification_message: undefined,
    last_stop_message: undefined,
    updated_at: "2026-04-08T12:00:00.000Z",
    ...overrides,
  };
}

function makeConfigWithVmEnvironment(
  sharedHostPath: string = "/tmp/pitch-shared",
): PitchConfig {
  return {
    defaults: {
      repo: undefined,
      agent: undefined,
      environment: undefined,
      base_branch: "main",
      worktree_root: "/tmp/worktrees",
    },
    bootstrap_prompts: {},
    repos: {},
    environments: {
      "sandbox-vm": {
        kind: "vm-ssh",
        ssh_host: "sandbox.internal",
        ssh_options: [],
        guest_workspace_root: "/srv/workspaces",
        shared_paths: [
          {
            host_path: sharedHostPath,
            guest_path: "/srv/pitch-shared",
            mode: "rw",
          },
        ],
        bootstrap: {
          mise_install: false,
        },
      },
    },
    sandboxes: {},
    agents: {},
  };
}

async function writeVmSummary(
  config: PitchConfig,
  counts: {
    running: number;
    question: number;
    idle: number;
    error: number;
  },
  activeSessions: number,
  generatedAt: string = "2026-04-08T12:00:00.000Z",
): Promise<void> {
  const environment = config.environments["sandbox-vm"];
  if (environment?.kind !== "vm-ssh") {
    throw new Error("sandbox-vm must be vm-ssh in test config");
  }

  const sharedPaths = resolveVmSharedAgentStatusPaths("sandbox-vm", environment);
  if (sharedPaths === null) {
    throw new Error("sandbox-vm must expose a shared cache path");
  }

  await writeAgentStatusSummary(
    {
      generated_at: generatedAt,
      active_sessions: activeSessions,
      counts,
    },
    sharedPaths.host_cache_dir,
  );
}

async function writeVmSessionState(
  config: PitchConfig,
  state: CodexSessionState | ClaudeSessionState,
): Promise<void> {
  const environment = config.environments["sandbox-vm"];
  if (environment?.kind !== "vm-ssh") {
    throw new Error("sandbox-vm must be vm-ssh in test config");
  }

  const sharedPaths = resolveVmSharedAgentStatusPaths("sandbox-vm", environment);
  if (sharedPaths === null) {
    throw new Error("sandbox-vm must expose a shared cache path");
  }

  if (state.agent_type === "codex") {
    await writeCodexSessionState(state, sharedPaths.host_cache_dir);
    return;
  }

  await writeClaudeSessionState(state, sharedPaths.host_cache_dir);
}

describe("handleCodexHookPayload", () => {
  it("stores running state for UserPromptSubmit events", async () => {
    const cacheDir = await makeTempCacheDir();

    await handleCodexHookPayload(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: "/tmp/worktrees/demo",
        transcript_path: "/tmp/transcripts/demo.jsonl",
      },
      cacheDir,
      {
        getCurrentTty: vi.fn(async () => "pts/21"),
        getCurrentTmuxContext: vi.fn(async () => ({
          session_name: "pitch",
          window_name: "tmux-sidebar",
          pane_id: "%12",
          pane_index: 0,
          pane_tty: "pts/21",
        })),
        listActiveCodexProcesses: vi.fn(async () => [
          {
            pid: 101,
            tty: "pts/21",
            cwd: "/tmp/worktrees/demo",
          },
        ]),
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      },
    );

    await expect(listCodexSessionStates(cacheDir)).resolves.toEqual([
      makeSessionState({
        state: "running",
        last_event: "UserPromptSubmit",
        last_assistant_message: undefined,
      }),
    ]);
  });

  it("stores question state only for explicit attention-seeking Stop messages", async () => {
    const cacheDir = await makeTempCacheDir();

    await handleCodexHookPayload(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: "/tmp/worktrees/demo",
        transcript_path: "/tmp/transcripts/demo.jsonl",
        last_assistant_message: "Would you like me to run the tests?",
      },
      cacheDir,
      {
        getCurrentTty: vi.fn(async () => "pts/21"),
        getCurrentTmuxContext: vi.fn(async () => ({
          session_name: "pitch",
          window_name: "tmux-sidebar",
          pane_id: "%12",
          pane_index: 0,
          pane_tty: "pts/21",
        })),
        listActiveCodexProcesses: vi.fn(async () => [
          {
            pid: 101,
            tty: "pts/21",
            cwd: "/tmp/worktrees/demo",
          },
        ]),
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      },
    );

    await expect(listCodexSessionStates(cacheDir)).resolves.toEqual([
      makeSessionState({
        state: "question",
        last_assistant_message: "Would you like me to run the tests?",
      }),
    ]);
  });

  it("keeps ordinary Stop questions in idle state for Codex", async () => {
    const cacheDir = await makeTempCacheDir();

    await handleCodexHookPayload(
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        cwd: "/tmp/worktrees/demo",
        transcript_path: "/tmp/transcripts/demo.jsonl",
        last_assistant_message: "What is the current working directory?",
      },
      cacheDir,
      {
        getCurrentTty: vi.fn(async () => "pts/21"),
        getCurrentTmuxContext: vi.fn(async () => ({
          session_name: "pitch",
          window_name: "tmux-sidebar",
          pane_id: "%12",
          pane_index: 0,
          pane_tty: "pts/21",
        })),
        listActiveCodexProcesses: vi.fn(async () => [
          {
            pid: 101,
            tty: "pts/21",
            cwd: "/tmp/worktrees/demo",
          },
        ]),
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      },
    );

    await expect(listCodexSessionStates(cacheDir)).resolves.toEqual([
      makeSessionState({
        state: "idle",
        last_assistant_message: "What is the current working directory?",
      }),
    ]);
  });

  it("accepts an explicit tty from the hook payload", async () => {
    const cacheDir = await makeTempCacheDir();

    await handleCodexHookPayload(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        tty: "/dev/pts/42",
      },
      cacheDir,
      {
        getCurrentTty: vi.fn(async () => undefined),
        getCurrentTmuxContext: vi.fn(async () => undefined),
        listActiveCodexProcesses: vi.fn(async () => [
          {
            pid: 142,
            tty: "pts/42",
            cwd: "/tmp/worktrees/demo",
          },
        ]),
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      },
    );

    await expect(listCodexSessionStates(cacheDir)).resolves.toEqual([
      makeSessionState({
        state: "running",
        cwd: undefined,
        transcript_path: undefined,
        tty: "pts/42",
        tmux_session: undefined,
        tmux_window: undefined,
        tmux_pane_id: undefined,
        tmux_pane_index: undefined,
        last_event: "UserPromptSubmit",
        last_assistant_message: undefined,
      }),
    ]);
  });
});

describe("handleClaudeHookPayload", () => {
  it("stores question state for Notification events", async () => {
    const cacheDir = await makeTempCacheDir();

    await handleClaudeHookPayload(
      {
        hook_event_name: "Notification",
        session_id: "claude-session-1",
        cwd: "/tmp/worktrees/claude-demo",
        transcript_path: "/tmp/transcripts/claude-demo.jsonl",
        message: "Claude needs permission to continue.",
      },
      cacheDir,
      {
        getCurrentTty: vi.fn(async () => "pts/31"),
        getCurrentTmuxContext: vi.fn(async () => ({
          session_name: "pitch",
          window_name: "tmux-sidebar",
          pane_id: "%31",
          pane_index: 0,
          pane_tty: "pts/31",
        })),
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      },
    );

    await expect(listClaudeSessionStates(cacheDir)).resolves.toEqual([
      makeClaudeSessionState({
        state: "question",
        last_event: "Notification",
        last_notification_message: "Claude needs permission to continue.",
      }),
    ]);
  });

  it("stores question state for approval-seeking Stop messages", async () => {
    const cacheDir = await makeTempCacheDir();

    await handleClaudeHookPayload(
      {
        hook_event_name: "Stop",
        session_id: "claude-session-1",
        cwd: "/tmp/worktrees/claude-demo",
        transcript_path: "/tmp/transcripts/claude-demo.jsonl",
        message:
          "Shall I remove dist/ and/or node_modules/? Let me know which, if any, you'd like removed.",
      },
      cacheDir,
      {
        getCurrentTty: vi.fn(async () => "pts/31"),
        getCurrentTmuxContext: vi.fn(async () => ({
          session_name: "pitch",
          window_name: "tmux-sidebar",
          pane_id: "%31",
          pane_index: 0,
          pane_tty: "pts/31",
        })),
        now: () => new Date("2026-04-08T12:00:00.000Z"),
      },
    );

    await expect(listClaudeSessionStates(cacheDir)).resolves.toEqual([
      makeClaudeSessionState({
        state: "question",
        last_event: "Stop",
        last_stop_message:
          "Shall I remove dist/ and/or node_modules/? Let me know which, if any, you'd like removed.",
      }),
    ]);
  });
});

describe("refreshAgentStatusSummary", () => {
  it("counts only sessions whose tty still has a live codex process", async () => {
    const cacheDir = await makeTempCacheDir();

    await writeCodexSessionState(makeSessionState(), cacheDir);
    await writeCodexSessionState(
      makeSessionState({
        session_id: "session-2",
        tty: "pts/22",
        state: "question",
        updated_at: "2026-04-08T12:01:00.000Z",
      }),
      cacheDir,
    );
    await writeCodexSessionState(
      makeSessionState({
        session_id: "session-3",
        tty: "pts/99",
        state: "idle",
        updated_at: "2026-04-08T12:02:00.000Z",
      }),
      cacheDir,
    );

    await expect(
      refreshAgentStatusSummary(cacheDir, {
        listActiveCodexProcesses: vi.fn(async () => [
          {
            pid: 201,
            tty: "pts/21",
            cwd: "/tmp/worktrees/demo",
          },
          {
            pid: 202,
            tty: "pts/22",
            cwd: "/tmp/worktrees/demo-2",
          },
        ]),
      }),
    ).resolves.toEqual({
      generated_at: expect.any(String),
      active_sessions: 2,
      counts: {
        running: 0,
        question: 1,
        idle: 1,
        error: 0,
      },
    });
  });

  it("deduplicates reused ttys by latest update time", async () => {
    const cacheDir = await makeTempCacheDir();

    await writeCodexSessionState(
      makeSessionState({
        session_id: "session-older",
        tty: "pts/21",
        state: "idle",
        updated_at: "2026-04-08T12:00:00.000Z",
      }),
      cacheDir,
    );
    await writeCodexSessionState(
      makeSessionState({
        session_id: "session-newer",
        tty: "pts/21",
        state: "running",
        updated_at: "2026-04-08T12:05:00.000Z",
      }),
      cacheDir,
    );

    const summary = await refreshAgentStatusSummary(cacheDir, {
      listActiveCodexProcesses: vi.fn(async () => [
        {
          pid: 201,
          tty: "pts/21",
          cwd: "/tmp/worktrees/demo",
        },
      ]),
    });

    expect(summary.active_sessions).toBe(1);
    expect(summary.counts).toEqual({
      running: 1,
      question: 0,
      idle: 0,
      error: 0,
    });

    const persisted = JSON.parse(
      await readFile(getAgentStatusSummaryPath(cacheDir), "utf8"),
    );
    expect(persisted.counts.running).toBe(1);
  });

  it("matches sessions without tty by unique active cwd", async () => {
    const cacheDir = await makeTempCacheDir();

    await writeCodexSessionState(
      makeSessionState({
        session_id: "session-no-tty",
        tty: undefined,
        cwd: "/tmp/worktrees/flog",
        state: "idle",
      }),
      cacheDir,
    );

    const summary = await refreshAgentStatusSummary(cacheDir, {
      listActiveCodexProcesses: vi.fn(async () => [
        {
          pid: 301,
          tty: "pts/32",
          cwd: "/tmp/worktrees/flog",
        },
      ]),
    });

    expect(summary.active_sessions).toBe(1);
    expect(summary.counts).toEqual({
      running: 0,
      question: 0,
      idle: 1,
      error: 0,
    });
  });

  it("prunes expired unmatched sessions from the cache", async () => {
    const cacheDir = await makeTempCacheDir();

    await writeCodexSessionState(
      makeSessionState({
        session_id: "session-stale",
        tty: "pts/44",
        updated_at: "2026-04-07T10:00:00.000Z",
      }),
      cacheDir,
    );

    const summary = await refreshAgentStatusSummary(cacheDir, {
      listActiveCodexProcesses: vi.fn(async () => []),
      loadConfig: vi.fn(
        async (): Promise<PitchConfig> => ({
          defaults: {
            base_branch: "main",
            worktree_root: "/tmp/worktrees",
          },
          bootstrap_prompts: {},
          repos: {},
          environments: {},
          sandboxes: {},
          agents: {},
        }),
      ),
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    expect(summary.active_sessions).toBe(0);
    expect(summary.counts).toEqual({
      running: 0,
      question: 0,
      idle: 0,
      error: 0,
    });
    await expect(listCodexSessionStates(cacheDir)).resolves.toEqual([]);
  });

  it("aggregates active Claude and Codex sessions together", async () => {
    const cacheDir = await makeTempCacheDir();

    await writeCodexSessionState(
      makeSessionState({
        session_id: "codex-running",
        tty: "pts/21",
        state: "running",
      }),
      cacheDir,
    );
    await writeClaudeSessionState(
      makeClaudeSessionState({
        session_id: "claude-question",
        tty: "pts/31",
        state: "question",
      }),
      cacheDir,
    );

    const summary = await refreshAgentStatusSummary(cacheDir, {
      listActiveCodexProcesses: vi.fn(async () => [
        {
          agent_type: "codex",
          pid: 201,
          tty: "pts/21",
          cwd: "/tmp/worktrees/demo",
        },
      ]),
      listActiveClaudeProcesses: vi.fn(async () => [
        {
          agent_type: "claude",
          pid: 301,
          tty: "pts/31",
          cwd: "/tmp/worktrees/claude-demo",
        },
      ]),
    });

    expect(summary.active_sessions).toBe(2);
    expect(summary.counts).toEqual({
      running: 1,
      question: 1,
      idle: 0,
      error: 0,
    });
  });

  it("merges remote vm source summaries into the top-level summary", async () => {
    const cacheDir = await makeTempCacheDir();
    const sharedHostPath = await makeTempCacheDir();
    const config = makeConfigWithVmEnvironment(sharedHostPath);

    await writeCodexSessionState(
      makeSessionState({
        session_id: "codex-running",
        tty: "pts/21",
        state: "running",
      }),
      cacheDir,
    );

    await writeVmSummary(
      config,
      {
        running: 0,
        question: 1,
        idle: 1,
        error: 0,
      },
      2,
    );

    const summary = await refreshAgentStatusSummary(cacheDir, {
      listActiveCodexProcesses: vi.fn(async () => [
        {
          agent_type: "codex",
          pid: 201,
          tty: "pts/21",
          cwd: "/tmp/worktrees/demo",
        },
      ]),
      loadConfig: vi.fn(async () => config),
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    expect(summary).toEqual({
      generated_at: "2026-04-08T12:00:00.000Z",
      active_sessions: 3,
      counts: {
        running: 1,
        question: 1,
        idle: 1,
        error: 0,
      },
    });
  });
});

describe("getAgentStatusSnapshot", () => {
  it("includes remote vm sessions alongside host sessions", async () => {
    const cacheDir = await makeTempCacheDir();
    const sharedHostPath = await makeTempCacheDir();
    const config = makeConfigWithVmEnvironment(sharedHostPath);

    await writeCodexSessionState(
      makeSessionState({
        session_id: "codex-running",
        tty: "pts/21",
        state: "running",
      }),
      cacheDir,
    );

    await writeVmSummary(
      config,
      {
        running: 0,
        question: 0,
        idle: 1,
        error: 0,
      },
      1,
    );
    await writeVmSessionState(
      config,
      makeClaudeSessionState({
        session_id: "claude-vm-idle",
        cwd: "/srv/workspaces/claude-demo",
        tty: "pts/44",
        tmux_session: undefined,
        tmux_window: undefined,
        tmux_pane_id: undefined,
        tmux_pane_index: undefined,
      }),
    );

    const snapshot = await getAgentStatusSnapshot(cacheDir, {
      listActiveCodexProcesses: vi.fn(async () => [
        {
          agent_type: "codex",
          pid: 201,
          tty: "pts/21",
          cwd: "/tmp/worktrees/demo",
        },
      ]),
      loadConfig: vi.fn(async () => config),
      now: () => new Date("2026-04-08T12:00:00.000Z"),
    });

    expect(snapshot.summary.active_sessions).toBe(2);
    expect(snapshot.sources).toEqual([
      {
        source: "host",
        summary: {
          generated_at: "2026-04-08T12:00:00.000Z",
          active_sessions: 1,
          counts: {
            running: 1,
            question: 0,
            idle: 0,
            error: 0,
          },
        },
      },
      {
        source: "sandbox-vm",
        summary: {
          generated_at: "2026-04-08T12:00:00.000Z",
          active_sessions: 1,
          counts: {
            running: 0,
            question: 0,
            idle: 1,
            error: 0,
          },
        },
      },
    ]);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions.map((session) => session.session_id)).toEqual([
      "codex-running",
      "claude-vm-idle",
    ]);
  });

  it("does not surface remote session files when the remote summary says there are no active sessions", async () => {
    const cacheDir = await makeTempCacheDir();
    const sharedHostPath = await makeTempCacheDir();
    const config = makeConfigWithVmEnvironment(sharedHostPath);

    await writeVmSummary(
      config,
      {
        running: 0,
        question: 0,
        idle: 0,
        error: 0,
      },
      0,
    );
    await writeVmSessionState(
      config,
      makeSessionState({
        session_id: "codex-vm-stale",
        cwd: "/srv/pitch-host/worktrees/kong/kongctl/pr-776",
        tty: undefined,
        tmux_session: undefined,
        tmux_window: undefined,
        tmux_pane_id: undefined,
        tmux_pane_index: undefined,
        updated_at: "2026-04-09T03:30:28.718Z",
      }),
    );

    const snapshot = await getAgentStatusSnapshot(cacheDir, {
      loadConfig: vi.fn(async () => config),
      now: () => new Date("2026-04-09T03:45:15.000Z"),
    });

    expect(snapshot.summary.active_sessions).toBe(0);
    expect(snapshot.sessions).toEqual([]);
  });

  it("ignores stale remote summaries in the aggregate snapshot", async () => {
    const cacheDir = await makeTempCacheDir();
    const sharedHostPath = await makeTempCacheDir();
    const config = makeConfigWithVmEnvironment(sharedHostPath);

    await writeVmSummary(
      config,
      {
        running: 1,
        question: 0,
        idle: 0,
        error: 0,
      },
      1,
      "2026-04-08T10:00:00.000Z",
    );

    const snapshot = await getAgentStatusSnapshot(cacheDir, {
      loadConfig: vi.fn(async () => config),
      now: () => new Date("2026-04-09T12:00:00.000Z"),
    });

    expect(snapshot.summary.active_sessions).toBe(0);
    expect(snapshot.sources).toEqual([
      {
        source: "host",
        summary: {
          generated_at: "2026-04-09T12:00:00.000Z",
          active_sessions: 0,
          counts: {
            running: 0,
            question: 0,
            idle: 0,
            error: 0,
          },
        },
      },
    ]);
    expect(snapshot.sessions).toEqual([]);
  });
});
