import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import type { AgentsView } from "../agents.js";
import { runCli, type CliDependencies } from "../cli.js";
import type { AgentStatusSnapshot } from "../agent-status.js";
import type { PitchConfig } from "../config.js";
import type { WorkspaceSummary } from "../workspace-query.js";
import type { WorkspaceRecord } from "../workspace-state.js";

function makeConfig(): PitchConfig {
  return {
    defaults: {
      repo: "kong/kongctl",
      agent: "codex",
      environment: "host-local",
      base_branch: "main",
      worktree_root: "~/.local/share/worktrees",
    },
    bootstrap_prompts: {},
    repos: {
      "kong/kongctl": {
        default_agent: "codex",
        default_environment: "host-local",
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        additional_paths: [],
        bootstrap_prompts: {},
        agent_defaults: {
          args: [],
          env: {},
        },
        agent_overrides: {},
      },
    },
    environments: {
      "host-local": {
        kind: "host",
      },
    },
    sandboxes: {},
    agents: {
      codex: {
        type: "codex",
        args: [],
        env: {},
      },
    },
  };
}

function makeWorkspaceRecord(
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  const workspace: WorkspaceRecord = {
    name: "pr-700-default-aas",
    worktree_name: "pr-700-default-aas",
    repo: "kong/kongctl",
    source_kind: "pr",
    source_number: 700,
    branch: "feature/default-aas",
    worktree_path: "/tmp/worktrees/pr-700-default-aas",
    guest_worktree_path: "/tmp/worktrees/pr-700-default-aas",
    base_branch: "main",
    tmux_session: "kongctl",
    tmux_window: "pr-700-default-aas",
    agent_name: "codex",
    agent_type: "codex",
    environment_name: "host-local",
    environment_kind: "host",
    agent_pane_process: "codex",
    agent_env: {
      CODEX_HOME: "~/.codex",
    },
    agent_sessions: [
      {
        id: "codex-session",
        started_at: "2026-04-01T12:00:00.000Z",
        status: "active",
      },
    ],
    status: "active",
    created_at: "2026-04-01T12:00:00.000Z",
    updated_at: "2026-04-01T12:00:00.000Z",
    ...overrides,
  };

  if (overrides.guest_worktree_path === undefined) {
    workspace.guest_worktree_path = workspace.worktree_path;
  }
  if (overrides.worktree_name === undefined) {
    workspace.worktree_name = workspace.name;
  }
  if (overrides.environment_kind === undefined) {
    workspace.environment_kind = "host";
  }
  if (overrides.environment_name === undefined) {
    workspace.environment_name = "host-local";
  }
  if (overrides.agent_pane_process === undefined) {
    workspace.agent_pane_process = "codex";
  }

  return workspace;
}

function makeWorkspaceSummary(
  overrides: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
  return {
    name: "pr-700-default-aas",
    repo: "kong/kongctl",
    source_kind: "pr",
    source_number: 700,
    status: "active",
    agent_name: "codex",
    agent_type: "codex",
    tmux_session: "kongctl",
    tmux_window: "pr-700-default-aas",
    ...overrides,
  };
}

function makeDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies & { stdoutBuffer: string[]; stderrBuffer: string[] } {
  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];

  return {
    listProvisionerInventory: vi.fn<CliDependencies["listProvisionerInventory"]>(async (input) => ({ kind: "provisioner_inventory", provisioner: input.provisioner, verify: input.verify === true, items: [], warnings: [] })),
    provisionerCompletionNames: vi.fn(async () => ({ provisioners: [], workspaces: [] })),
    refreshWorkspaceEnvironment: vi.fn(async () => "/example/environment.sh"),
    reprovisionWorkspaceProvisioner: vi.fn(async () => "/example/environment.sh"),
    cleanupWorkspaceProvisioner: vi.fn(async () => "example deactivated"),
    pruneProvisionerHistory: vi.fn(async (input) => ({ dry_run: input.dry_run === true, items: [], warnings: [] })),
    getAgentsView: vi.fn(async (): Promise<AgentsView> => ({
      summary: {
        generated_at: "2026-04-08T12:00:00.000Z",
        active_sessions: 2,
        counts: {
          running: 1,
          question: 1,
          idle: 0,
          error: 0,
        },
      },
      agents: [
        {
          agent_type: "claude",
          agent_name: "claude-enterprise",
          state: "question",
          session_id: "claude-session-1",
          session_key: "claude-sessi",
          last_event: "Notification",
          updated_at: "2026-04-08T12:00:00.000Z",
          cwd: "/tmp/claude",
          tty: "pts/31",
          tmux: {
            session_name: "pitch",
            window_name: "tmux-sidebar",
            pane_index: 0,
            pane_id: "%12",
            pane_tty: "pts/31",
            current_command: "claude",
            current_path: "/tmp/claude",
          },
        },
        {
          agent_type: "codex",
          agent_name: "codex-api",
          state: "running",
          session_id: "codex-session-1",
          session_key: "codex-sessio",
          last_event: "UserPromptSubmit",
          updated_at: "2026-04-08T11:59:00.000Z",
          cwd: "/tmp/codex",
          tty: "pts/21",
          tmux: undefined,
        },
      ],
    })),
    jumpToAgentSession: vi.fn(async () => ({
      agent_type: "claude" as const,
      agent_name: "claude-enterprise",
      state: "question" as const,
      session_id: "claude-session-1",
      session_key: "claude-sessi",
      last_event: "Notification",
      updated_at: "2026-04-08T12:00:00.000Z",
      cwd: "/tmp/claude",
      tty: "pts/31",
      tmux: {
        session_name: "pitch",
        window_name: "tmux-sidebar",
        pane_index: 0,
        pane_id: "%12",
        pane_tty: "pts/31",
        current_command: "claude",
        current_path: "/tmp/claude",
      },
    })),
    displayTmuxMenu: vi.fn(async () => undefined),
    listTmuxSessions: vi.fn(async () => ["kongctl", "kongctl-aigw"]),
    getAgentStatusSnapshot: vi.fn(async (): Promise<AgentStatusSnapshot> => ({
      summary: {
        generated_at: "2026-04-08T12:00:00.000Z",
        active_sessions: 2,
        counts: {
          running: 1,
          question: 1,
          idle: 0,
          error: 0,
        },
      },
      sources: [
        {
          source: "host",
          summary: {
            generated_at: "2026-04-08T12:00:00.000Z",
            active_sessions: 2,
            counts: {
              running: 1,
              question: 1,
              idle: 0,
              error: 0,
            },
          },
        },
      ],
      sessions: [
        {
          session_id: "claude-session-1",
          agent_type: "claude",
          state: "question",
          cwd: "/tmp/claude",
          transcript_path: "/tmp/claude.jsonl",
          tty: "pts/31",
          last_event: "Notification",
          last_notification_message: "Claude needs input.",
          last_stop_message: undefined,
          error_message: undefined,
          updated_at: "2026-04-08T12:00:00.000Z",
        },
        {
          session_id: "codex-session-1",
          agent_type: "codex",
          state: "running",
          cwd: "/tmp/codex",
          transcript_path: "/tmp/codex.jsonl",
          tty: "pts/21",
          last_event: "UserPromptSubmit",
          last_assistant_message: undefined,
          error_message: undefined,
          updated_at: "2026-04-08T11:59:00.000Z",
        },
      ],
    })),
    markAgentSessionError: vi.fn(async () => ({
      session_id: "codex-session-1",
      agent_type: "codex" as const,
      state: "error" as const,
      cwd: "/tmp/codex",
      transcript_path: undefined,
      tty: "pts/21",
      last_event: "Error",
      last_assistant_message: undefined,
      error_message: "failed",
      updated_at: "2026-04-08T12:00:00.000Z",
    })),
    loadConfig: vi.fn(async () => makeConfig()),
    createWorkspace: vi.fn(async () => makeWorkspaceRecord()),
    listWorkspaces: vi.fn(async () => [makeWorkspaceSummary()]),
    getWorkspace: vi.fn(async () => makeWorkspaceRecord()),
    resumeWorkspace: vi.fn(async () => makeWorkspaceRecord()),
    moveWorkspace: vi.fn(async () =>
      makeWorkspaceRecord({ tmux_session: "kongctl-aigw" }),
    ),
    renameWorkspace: vi.fn(async () =>
      makeWorkspaceRecord({
        name: "renamed-workspace",
        tmux_window: "renamed-workspace",
      }),
    ),
    closeWorkspace: vi.fn(async () => makeWorkspaceRecord({ status: "closed" })),
    deleteWorkspace: vi.fn(async () => makeWorkspaceRecord({ status: "closed" })),
    renderStatusRight: vi.fn(async () => "R:2 I:1"),
    renderWaybarStatus: vi.fn(async () =>
      JSON.stringify({
        text: "<span foreground=\"#7DAF7D\">R:1</span>",
        tooltip: "Pitch Agents",
        class: ["pitch-agents", "running"],
      }),
    ),
    watchWaybarStatus: vi.fn(async (output) => {
      output.write("{\"text\":\"watch\"}\n");
    }),
    stdin: Readable.from([]),
    stdout: {
      write(chunk: string) {
        stdoutBuffer.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrBuffer.push(chunk);
      },
    },
    stdoutBuffer,
    stderrBuffer,
    ...overrides,
  };
}

describe("runCli", () => {
  it("previews local pruning and keeps the command read-only when --dry-run is passed", async () => {
    const dependencies = makeDependencies();
    expect(await runCli(["prune", "konnect_org", "--dry-run", "--repo", "kong/kongctl", "--json"], dependencies)).toBe(0);
    expect(dependencies.pruneProvisionerHistory).toHaveBeenCalledWith({ provisioner: "konnect_org", repo: "kong/kongctl", dry_run: true }, expect.any(Object));
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toMatchObject({ command: "prune", result: { dry_run: true } });
    expect(dependencies.cleanupWorkspaceProvisioner).not.toHaveBeenCalled();
  });

  it.each([["prune"], ["prune", "example", "--verify"], ["prune", "example", "extra"]])("rejects invalid pruning syntax %j", async (...args) => {
    const dependencies = makeDependencies();
    expect(await runCli(args, dependencies)).toBe(1);
    expect(dependencies.pruneProvisionerHistory).not.toHaveBeenCalled();
  });

  it("completes retained provisioners and abandoned workspace names", async () => {
    const dependencies = makeDependencies({ provisionerCompletionNames: vi.fn(async () => ({ provisioners: ["retired_provider"], workspaces: ["abandoned"] })) });
    expect(await runCli(["__complete-provisioners"], dependencies)).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toContain("retired_provider");
    dependencies.stdoutBuffer.length = 0;
    expect(await runCli(["__complete-config", "cleanup-workspaces"], dependencies)).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toContain("abandoned");
  });

  it.each(["repos", "agents", "environments"])("completes configured %s", async (kind) => {
    const dependencies = makeDependencies();
    expect(await runCli(["__complete-config", kind], dependencies)).toBe(0);
    const config = await dependencies.loadConfig();
    expect(dependencies.stdoutBuffer.join("").trim().split("\n")).toEqual(Object.keys(config[kind as "repos" | "agents" | "environments"]).sort());
  });

  it("loads completion directly and dispatches every public command in zsh", async () => {
    const dependencies = makeDependencies();
    await runCli(["completion", "zsh"], dependencies);
    const completion = dependencies.stdoutBuffer.join("");
    // Source at top level, as with `source <(pitch completion zsh)`, then
    // exercise dispatch with zsh's own array/index semantics.
    const prelude = 'compdef() { print -r -- "registered:$*"; }\n';
    const commands = ["create", "agents", "agents-popup", "jump", "agent-status", "agent-error", "list", "get", "show",
      "refresh", "reprovision", "cleanup", "prune", "resume", "restart", "move", "rename", "close", "delete", "status-right", "waybar-status", "view", "completion", "help"];
    const script = prelude + completion + '\n_arguments() { print -r -- "arguments:$*"; }\n' +
      '_pitch_complete_workspace_target() { return 1; }\n' +
      commands.map((command) => `words=(pitch ${command} ''); CURRENT=3; print -r -- 'command:${command}'; _pitch`).join("\n");
    const output = execFileSync("zsh", ["-f", "-c", script], { encoding: "utf8" });
    expect(output).toContain("registered:_pitch pitch");
    for (const command of commands) expect(output).toContain(`command:${command}\narguments:`);
    expect(output).toContain("1:workspace:_pitch_workspaces");
    expect(output).toContain("1:provisioner:_pitch_provisioners");
    expect(output).toContain("--workspace[Workspace name]:workspace:_pitch_cleanup_workspaces");
    expect(output).toContain("--dry-run[Preview local history removal]");
    expect(output).toContain("--repo[Repository]:repo:_pitch_repos");
  });

  it("prints retained inventory rows and exits unsuccessfully when verification fails", async () => {
    const dependencies = makeDependencies({
      listProvisionerInventory: vi.fn<CliDependencies["listProvisionerInventory"]>(async () => ({
        kind: "provisioner_inventory", provisioner: "konnect_org", verify: true,
        warnings: ["example_com: verification failed.\n  Record: /record.json", "other_com: verification failed."],
        items: [{ resource_id: "a".repeat(32), record: "/record.json", archived: false,
          provisioner: "konnect_org", repo: "kong/kongctl", workspace: "example", workspace_status: "missing",
          status: "orphaned", orphaned: true, lifecycle: "ready", name: "example_com", id: "org-id",
          environment: "prod", created_at: null, deactivated_at: null, remote_state: null, verification: "failed" }],
      })),
    });
    expect(await runCli(["list", "konnect_org", "--verify"], dependencies)).toBe(1);
    expect(dependencies.stdoutBuffer.join("")).toContain("example_com");
    expect(dependencies.stdoutBuffer.join("")).toContain("unverified");
    expect(dependencies.stderrBuffer.join("")).toBe(
      "- Warning: example_com: verification failed.\n  Record: /record.json\n- Warning: other_com: verification failed.\n",
    );
  });

  it("completes configured provisioner names", async () => {
    const config = makeConfig();
    config.provisioners = { konnect_org: { create: ["create"], delete: ["delete"] } };
    const dependencies = makeDependencies({ loadConfig: vi.fn(async () => config) });
    expect(await runCli(["__complete-provisioners"], dependencies)).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toBe("konnect_org\n");
  });
  it("routes provisioner inventory flags without invoking workspace listing", async () => {
    const dependencies = makeDependencies();
    const code = await runCli(["list", "konnect_org", "--orphaned", "--all", "--verify", "--repo", "kong/kongctl", "--json"], dependencies);
    expect(code).toBe(0);
    expect(dependencies.listProvisionerInventory).toHaveBeenCalledWith({ provisioner: "konnect_org", orphaned: true, all: true, verify: true, repo: "kong/kongctl" }, expect.any(Object));
    expect(dependencies.listWorkspaces).not.toHaveBeenCalled();
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toMatchObject({ command: "list", result: { kind: "provisioner_inventory", items: [] } });
  });

  it.each([["list", "--orphaned"], ["list", "konnect_org", "--status", "closed"], ["list", "konnect_org", "extra"]])("rejects ambiguous inventory arguments %j", async (...args) => {
    const dependencies = makeDependencies();
    expect(await runCli(args, dependencies)).toBe(1);
    expect(dependencies.listProvisionerInventory).not.toHaveBeenCalled();
  });
  it("refreshes a workspace environment and prints only its file path", async () => {
    const dependencies = makeDependencies();
    expect(await runCli(["refresh", "example"], dependencies)).toBe(0);
    expect(dependencies.refreshWorkspaceEnvironment).toHaveBeenCalledWith("example", expect.any(Object));
    expect(dependencies.stdoutBuffer.join("")).toBe("/example/environment.sh\n");
  });

  it("reprovisions a selected workspace resource and returns its environment path", async () => {
    const dependencies = makeDependencies();
    expect(await runCli(["reprovision", "konnect_org", "--workspace", "example", "--json"], dependencies)).toBe(0);
    expect(dependencies.reprovisionWorkspaceProvisioner).toHaveBeenCalledWith("konnect_org", "example", expect.any(Object));
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toMatchObject({ command: "reprovision", result: "/example/environment.sh" });
  });

  it.each([
    ["reprovision"], ["reprovision", "konnect_org"], ["reprovision", "konnect_org", "extra", "--workspace", "example"],
    ["reprovision", "konnect_org", "--workspace", "example", "--force"],
  ])("rejects invalid reprovision arguments %j", async (...args) => {
    const dependencies = makeDependencies();
    expect(await runCli(args, dependencies)).toBe(1);
    expect(dependencies.reprovisionWorkspaceProvisioner).not.toHaveBeenCalled();
  });

  it.each([
    ["env", "refresh", "example"], ["refresh"], ["refresh", "one", "two"],
    ["refresh", "example", "--force"], ["cleanup", "example"],
    ["cleanup", "--workspace", "example"], ["cleanup", "example", "--workspace", "test", "--force"],
    ["show"], ["show", "example", "--verify"],
  ])("rejects invalid maintenance arguments %j", async (...args) => {
    const dependencies = makeDependencies();
    expect(await runCli(args, dependencies)).toBe(1);
    expect(dependencies.refreshWorkspaceEnvironment).not.toHaveBeenCalled();
    expect(dependencies.cleanupWorkspaceProvisioner).not.toHaveBeenCalled();
    expect(dependencies.getWorkspace).not.toHaveBeenCalled();
  });

  it("cleans up only the selected provisioner and supports JSON", async () => {
    const dependencies = makeDependencies();
    expect(await runCli(["cleanup", "example", "--workspace", "test", "--repo", "owner/repo", "--json"], dependencies)).toBe(0);
    expect(dependencies.cleanupWorkspaceProvisioner).toHaveBeenCalledWith("example", "test", expect.any(Object), "owner/repo");
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toMatchObject({ command: "cleanup", result: "example deactivated" });
  });

  it("shows workspace details including its environment file without refreshing", async () => {
    const dependencies = makeDependencies();
    const workspace = await dependencies.getWorkspace({ name: "example" });
    vi.mocked(dependencies.getWorkspace).mockResolvedValue({ ...workspace, environment_file: "/example/environment.sh" });
    expect(await runCli(["show", "example"], dependencies)).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toContain("environment file: /example/environment.sh");
    expect(dependencies.refreshWorkspaceEnvironment).not.toHaveBeenCalled();
  });

  it("returns the refresh path as a JSON result when requested", async () => {
    const dependencies = makeDependencies();
    expect(await runCli(["refresh", "example", "--json"], dependencies)).toBe(0);
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toMatchObject({ command: "refresh", result: "/example/environment.sh" });
  });
  it("renders agents with tmux targets", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["agents"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.getAgentsView).toHaveBeenCalledTimes(1);
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "summary: R:1 Q:1 I:0 E:0",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "pitch:tmux-sidebar.0",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain("claude-enter");
    expect(dependencies.stdoutBuffer.join("")).toContain("claude-sessi");
    expect(dependencies.stdoutBuffer.join("")).toContain("question");
  });

  it("supports interactive agent picking", async () => {
    const dependencies = makeDependencies({
      stdin: Readable.from(["1\n"]),
    });

    const exitCode = await runCli(["agents", "--pick"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.getAgentsView).toHaveBeenCalledTimes(1);
    expect(dependencies.jumpToAgentSession).toHaveBeenCalledWith(
      "claude-session-1",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain("Jump to agent #:");
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "Focused claude session claude-session-1.",
    );
  });

  it("opens the tmux agent popup", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["agents-popup"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.getAgentsView).toHaveBeenCalledTimes(1);
    expect(dependencies.displayTmuxMenu).toHaveBeenCalledTimes(1);
    expect(dependencies.stdoutBuffer.join("")).toBe("");
  });

  it("jumps to a live agent session by unique prefix", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["jump", "claude-sessi"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.jumpToAgentSession).toHaveBeenCalledWith(
      "claude-sessi",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "Focused claude session claude-session-1.",
    );
  });

  it("renders a human-readable agent status snapshot", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["agent-status"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.getAgentStatusSnapshot).toHaveBeenCalledTimes(1);
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "summary: R:1 Q:1 I:0 E:0",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "- claude question claude-session-1 Notification 2026-04-08T12:00:00.000Z",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain("  tty: pts/31");
  });

  it("records an explicit agent error state", async () => {
    const dependencies = makeDependencies({
      markAgentSessionError: vi.fn(async () => ({
        session_id: "claude-session-1",
        agent_type: "claude" as const,
        state: "error" as const,
        cwd: "/tmp/claude",
        transcript_path: undefined,
        tty: "pts/31",
        last_event: "Error",
        last_notification_message: undefined,
        last_stop_message: undefined,
        error_message: "hook failed",
        updated_at: "2026-04-08T12:10:00.000Z",
      })),
    });

    const exitCode = await runCli(
      [
        "agent-error",
        "--agent-type",
        "claude",
        "--session-id",
        "claude-session-1",
        "--message",
        "hook failed",
        "--tty",
        "pts/31",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.markAgentSessionError).toHaveBeenCalledWith({
      agent_type: "claude",
      session_id: "claude-session-1",
      message: "hook failed",
      cwd: undefined,
      transcript_path: undefined,
      tty: "pts/31",
    });
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "Recorded agent error state.",
    );
  });

  it("dispatches top-level create to createWorkspace", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["create", "--pr", "700", "--slug", "default-aas", "--skip-prompt"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.loadConfig).toHaveBeenCalledTimes(1);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      {
        repo: undefined,
        issue: undefined,
        pr: 700,
        name: undefined,
        slug: "default-aas",
        branch: undefined,
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        skip_prompt: true,
        model: undefined,
        prompt: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "name: pr-700-default-aas",
    );
  });

  it("passes repeatable additional dirs through create", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      [
        "create",
        "--pr",
        "700",
        "--additional-dir",
        "/tmp/shared",
        "--add-dir=/tmp/cache",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: 700,
        additional_paths: ["/tmp/shared", "/tmp/cache"],
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes a repository context through create", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["create", "--pr", "700", "--context", "e2e-com"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ context: "e2e-com" }),
      makeConfig(),
      { reportWarning: expect.any(Function) },
    );
  });

  it("passes an explicit tmux session through create", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["create", "--pr", "700", "--tmux-session", "kongctl-aigw"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: 700,
        tmux_session: "kongctl-aigw",
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("rejects --name with --pr before createWorkspace", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["create", "--pr", "1193", "--name", "pat-ee2e"],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.stderrBuffer.join("")).toContain(
      "--name creates an ad hoc workspace and cannot be combined with --pr. Use --slug pat-ee2e to create pr-1193-pat-ee2e, or omit --pr to create an ad hoc workspace named pat-ee2e.",
    );
  });

  it("rejects multiple GitHub create sources before createWorkspace", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["create", "--issue", "42", "--pr", "700"],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.stderrBuffer.join("")).toContain(
      "pitch: Choose either --issue N or --pr N, not both.",
    );
  });

  it("dispatches an ad hoc create with name and branch to createWorkspace", async () => {
    const dependencies = makeDependencies({
      createWorkspace: vi.fn(async () =>
        makeWorkspaceRecord({
          name: "spike-auth",
          worktree_name: "spike-auth",
          source_kind: "adhoc",
          source_number: null,
          branch: "feature/auth",
          worktree_path: "/tmp/worktrees/spike-auth",
          guest_worktree_path: "/tmp/worktrees/spike-auth",
          tmux_window: "spike-auth",
        })),
    });

    const exitCode = await runCli(
      ["create", "--name", "spike-auth", "--branch", "feature/auth"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      {
        repo: undefined,
        issue: undefined,
        pr: undefined,
        name: "spike-auth",
        slug: undefined,
        branch: "feature/auth",
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        skip_prompt: undefined,
        model: undefined,
        prompt: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
    expect(dependencies.stdoutBuffer.join("")).toContain("name: spike-auth");
    expect(dependencies.stdoutBuffer.join("")).toContain("source: adhoc");
  });

  it("dispatches top-level create without a slug", async () => {
    const dependencies = makeDependencies({
      createWorkspace: vi.fn(async () =>
        makeWorkspaceRecord({
          name: "pr-700",
          worktree_name: "pr-700",
          worktree_path: "/tmp/worktrees/pr-700",
          guest_worktree_path: "/tmp/worktrees/pr-700",
          tmux_window: "pr-700",
        })),
    });

    const exitCode = await runCli(
      ["create", "--pr", "700"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      {
        repo: undefined,
        issue: undefined,
        pr: 700,
        name: undefined,
        slug: undefined,
        branch: undefined,
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        skip_prompt: undefined,
        model: undefined,
        prompt: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "name: pr-700",
    );
  });

  it("implies create when only create-shape flags are provided", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["--pr", "700", "--slug", "default-aas", "--skip-prompt"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      {
        repo: undefined,
        issue: undefined,
        pr: 700,
        name: undefined,
        slug: "default-aas",
        branch: undefined,
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        skip_prompt: true,
        model: undefined,
        prompt: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("implies create when only --pr is provided", async () => {
    const dependencies = makeDependencies({
      createWorkspace: vi.fn(async () =>
        makeWorkspaceRecord({
          name: "pr-700",
          worktree_name: "pr-700",
          worktree_path: "/tmp/worktrees/pr-700",
          guest_worktree_path: "/tmp/worktrees/pr-700",
          tmux_window: "pr-700",
        })),
    });

    const exitCode = await runCli(
      ["--pr", "700"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      {
        repo: undefined,
        issue: undefined,
        pr: 700,
        name: undefined,
        slug: undefined,
        branch: undefined,
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        skip_prompt: undefined,
        model: undefined,
        prompt: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes trailing create text as additional prompt text", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      [
        "create",
        "--pr",
        "700",
        "--slug",
        "default-aas",
        "focus",
        "on",
        "the",
        "retry",
        "path",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: 700,
        slug: "default-aas",
        prompt: "focus on the retry path",
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes --prompt as additional prompt text", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      [
        "create",
        "--pr",
        "700",
        "--slug",
        "default-aas",
        "--prompt",
        "focus on the retry path",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        pr: 700,
        slug: "default-aas",
        prompt: "focus on the retry path",
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("rejects mixed --prompt and trailing create text", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      [
        "create",
        "--pr",
        "700",
        "--prompt",
        "focus",
        "extra",
      ],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.stderrBuffer.join("")).toContain(
      "pitch: Use either --prompt TEXT or trailing prompt text, not both.",
    );
  });

  it("passes implicit create trailing text as additional prompt text", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["--issue", "42", "--", "verify", "--flag-shaped", "text"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        issue: 42,
        prompt: "verify --flag-shaped text",
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("accepts the workspace alias and emits json", async () => {
    const dependencies = makeDependencies({
      createWorkspace: vi.fn(async (_params, _config, overrides) => {
        overrides?.reportWarning?.("GitHub assignment failed");
        return makeWorkspaceRecord();
      }),
    });

    const exitCode = await runCli(
      [
        "workspace",
        "create",
        "--pr",
        "700",
        "--slug",
        "default-aas",
        "--skip_prompt",
        "--json",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toEqual({
      command: "create",
      result: makeWorkspaceRecord(),
      warnings: ["GitHub assignment failed"],
    });
  });

  it("lists workspaces without loading config", async () => {
    const dependencies = makeDependencies({
      listWorkspaces: vi.fn(async () => [
        makeWorkspaceSummary(),
        makeWorkspaceSummary({
          name: "gh-42-fix-bug",
          source_kind: "issue",
          source_number: 42,
          status: "closed",
          agent_name: "claude",
          agent_type: "claude",
          tmux_window: "gh-42-fix-bug",
        }),
      ]),
    });

    const exitCode = await runCli(["list", "--status", "all"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
    expect(dependencies.listWorkspaces).toHaveBeenCalledWith({
      repo: undefined,
      status: "all",
    });
    expect(dependencies.stdoutBuffer.join("")).toContain("Name");
    expect(dependencies.stdoutBuffer.join("")).toContain("gh-42-fix-bug");
  });

  it("sorts listed workspaces by status then name by default", async () => {
    const dependencies = makeDependencies({
      listWorkspaces: vi.fn(async () => [
        makeWorkspaceSummary({ name: "z-closed", status: "closed" }),
        makeWorkspaceSummary({ name: "b-active", status: "active" }),
        makeWorkspaceSummary({ name: "a-closed", status: "closed" }),
        makeWorkspaceSummary({ name: "a-active", status: "active" }),
      ]),
    });

    const exitCode = await runCli(
      ["list", "--status", "all", "--json"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(dependencies.stdoutBuffer.join(""));
    expect(
      output.result.map((workspace: WorkspaceSummary) => workspace.name),
    ).toEqual(["a-active", "b-active", "a-closed", "z-closed"]);
  });

  it("sorts listed workspaces by name when requested", async () => {
    const dependencies = makeDependencies({
      listWorkspaces: vi.fn(async () => [
        makeWorkspaceSummary({ name: "z-active", status: "active" }),
        makeWorkspaceSummary({ name: "b-closed", status: "closed" }),
        makeWorkspaceSummary({ name: "a-active", status: "active" }),
      ]),
    });

    const exitCode = await runCli(
      ["list", "--status", "all", "--sort", "name", "--json"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(dependencies.stdoutBuffer.join(""));
    expect(
      output.result.map((workspace: WorkspaceSummary) => workspace.name),
    ).toEqual(["a-active", "b-closed", "z-active"]);
  });

  it("sorts listed workspaces by status then source when requested", async () => {
    const dependencies = makeDependencies({
      listWorkspaces: vi.fn(async () => [
        makeWorkspaceSummary({
          name: "z-pr",
          source_kind: "pr",
          source_number: 7,
          status: "active",
        }),
        makeWorkspaceSummary({
          name: "b-issue",
          source_kind: "issue",
          source_number: 2,
          status: "active",
        }),
        makeWorkspaceSummary({
          name: "a-adhoc",
          source_kind: "adhoc",
          source_number: null,
          status: "closed",
        }),
        makeWorkspaceSummary({
          name: "c-pr",
          source_kind: "pr",
          source_number: 1,
          status: "active",
        }),
      ]),
    });

    const exitCode = await runCli(
      ["list", "--status", "all", "--sort", "status,source", "--json"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    const output = JSON.parse(dependencies.stdoutBuffer.join(""));
    expect(
      output.result.map((workspace: WorkspaceSummary) => workspace.name),
    ).toEqual(["b-issue", "c-pr", "z-pr", "a-adhoc"]);
  });

  it("groups listed workspaces by status in human output", async () => {
    const dependencies = makeDependencies({
      listWorkspaces: vi.fn(async () => [
        makeWorkspaceSummary({ name: "z-closed", status: "closed" }),
        makeWorkspaceSummary({ name: "b-active", status: "active" }),
        makeWorkspaceSummary({ name: "a-active", status: "active" }),
      ]),
    });

    const exitCode = await runCli(
      ["list", "--status", "all", "--group-by", "status"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    const output = dependencies.stdoutBuffer.join("");
    expect(output.indexOf("active (2)")).toBeLessThan(
      output.indexOf("closed (1)"),
    );
    expect(output.indexOf("a-active")).toBeLessThan(
      output.indexOf("b-active"),
    );
  });

  it("emits grouped workspace JSON when requested", async () => {
    const dependencies = makeDependencies({
      listWorkspaces: vi.fn(async () => [
        makeWorkspaceSummary({ name: "z-closed", status: "closed" }),
        makeWorkspaceSummary({ name: "a-active", status: "active" }),
      ]),
    });

    const exitCode = await runCli(
      ["list", "--status", "all", "--group-by", "status", "--json"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toMatchObject({
      command: "list",
      result: {
        group_by: "status",
        groups: [
          {
            key: "status",
            value: "active",
            label: "active",
            workspaces: [{ name: "a-active" }],
          },
          {
            key: "status",
            value: "closed",
            label: "closed",
            workspaces: [{ name: "z-closed" }],
          },
        ],
      },
      warnings: [],
    });
  });

  it("rejects invalid workspace list sort options", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["list", "--sort", "unknown"], dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.stderrBuffer.join("")).toContain(
      "Option --sort expects comma-separated fields. Valid fields:",
    );
  });

  it("rejects invalid workspace list group fields", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["list", "--group-by", "status,repo"],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.stderrBuffer.join("")).toContain(
      "Option --group-by expects one field. Valid fields:",
    );
  });

  it("uses a positional workspace name for get", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["get", "pr-700-default-aas"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.getWorkspace).toHaveBeenCalledWith({
      name: "pr-700-default-aas",
    });
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });

  it("passes overrides through resume", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["resume", "pr-700-default-aas", "--agent", "codex"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        agent: "codex",
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        reset_session: undefined,
        restart_agent: undefined,
        sync: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes repeatable additional dirs through resume", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      [
        "resume",
        "pr-700-default-aas",
        "--additional-dir=/tmp/shared",
        "--add-dir",
        "/tmp/cache",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pr-700-default-aas",
        additional_paths: ["/tmp/shared", "/tmp/cache"],
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes a repository context through restart", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["restart", "pr-700-default-aas", "--context", "e2e-tech"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pr-700-default-aas",
        context: "e2e-tech",
        restart_agent: true,
      }),
      makeConfig(),
      { reportWarning: expect.any(Function) },
    );
  });

  it("passes an explicit tmux session through resume", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["resume", "pr-700-default-aas", "--tmux-session", "kongctl-aigw"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pr-700-default-aas",
        tmux_session: "kongctl-aigw",
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes sync through resume", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["resume", "pr-700-default-aas", "--sync"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        agent: undefined,
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        reset_session: undefined,
        restart_agent: undefined,
        sync: true,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes restart mode through restart", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["restart", "pr-700-default-aas", "--agent", "codex"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        agent: "codex",
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        reset_session: undefined,
        restart_agent: true,
        sync: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes an explicit tmux session through restart", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["restart", "pr-700-default-aas", "--tmux-session", "kongctl-aigw"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pr-700-default-aas",
        tmux_session: "kongctl-aigw",
        restart_agent: true,
      }),
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("moves a workspace to another tmux session", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["move", "pr-700-default-aas", "--to", "kongctl-aigw"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.moveWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        tmux_session: "kongctl-aigw",
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "tmux: kongctl-aigw:pr-700-default-aas",
    );
  });

  it("rejects move without a target tmux session", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["move", "pr-700-default-aas"],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.moveWorkspace).not.toHaveBeenCalled();
    expect(dependencies.stderrBuffer.join("")).toContain(
      "Missing required option --to.",
    );
  });

  it("renames a workspace", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["rename", "pr-700-default-aas", "renamed-workspace"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.renameWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        new_name: "renamed-workspace",
      },
      makeConfig(),
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "name: renamed-workspace",
    );
  });

  it("rejects rename without a new workspace name", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["rename", "pr-700-default-aas"],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.renameWorkspace).not.toHaveBeenCalled();
    expect(dependencies.stderrBuffer.join("")).toContain(
      "Missing new workspace name.",
    );
  });

  it("prompts to retry delete with force when git cleanup fails", async () => {
    const dependencies = makeDependencies({
      stdin: Readable.from(["y\n"]) as NodeJS.ReadableStream,
      deleteWorkspace: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            "Failed to remove worktree for pr-797-attributes: Git command failed in /home/rspurgeon/dev/kong/kongctl: git worktree remove /home/rspurgeon/.local/share/worktrees/kong/kongctl/pr-797\nRetry with --force to remove the worktree directory directly.",
          ),
        )
        .mockResolvedValueOnce(makeWorkspaceRecord({
          name: "pr-797-attributes",
          worktree_name: "pr-797",
          source_kind: "pr",
          source_number: 797,
          branch: "branch-797",
          worktree_path: "/tmp/worktrees/pr-797",
          tmux_window: "pr-797-attributes",
          status: "closed",
        })),
    });

    const exitCode = await runCli(
      ["delete", "pr-797-attributes"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.deleteWorkspace).toHaveBeenNthCalledWith(
      1,
      {
        name: "pr-797-attributes",
        force: undefined,
        delete_branch_if_empty: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
    expect(dependencies.deleteWorkspace).toHaveBeenNthCalledWith(
      2,
      {
        name: "pr-797-attributes",
        force: true,
        delete_branch_if_empty: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes an explicit session id through create", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["create", "--pr", "700", "--session-id", "019d6505-21ab-7493-9ea5-e10084cc79f0"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      {
        repo: undefined,
        issue: undefined,
        pr: 700,
        name: undefined,
        slug: undefined,
        branch: undefined,
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        session_id: "019d6505-21ab-7493-9ea5-e10084cc79f0",
        tmux_session: undefined,
        skip_prompt: undefined,
        model: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes an explicit session id through resume", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["resume", "pr-700-default-aas", "--session-id", "019d6505-21ab-7493-9ea5-e10084cc79f0"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        agent: undefined,
        environment: undefined,
        session_id: "019d6505-21ab-7493-9ea5-e10084cc79f0",
        tmux_session: undefined,
        reset_session: undefined,
        restart_agent: undefined,
        sync: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("passes reset_session through resume", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["resume", "pr-700-default-aas", "--reset-session"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.resumeWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        agent: undefined,
        environment: undefined,
        session_id: undefined,
        tmux_session: undefined,
        reset_session: true,
        restart_agent: undefined,
        sync: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("closes a workspace without delete flags", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["close", "pr-700-default-aas"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.closeWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("dispatches delete separately and supports force", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["delete", "pr-700-default-aas", "--force"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.deleteWorkspace).toHaveBeenCalledWith(
      {
        name: "pr-700-default-aas",
        force: true,
        delete_branch_if_empty: undefined,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "status: closed",
    );
  });

  it("renders the tmux status-right segment", async () => {
    const dependencies = makeDependencies({
      renderStatusRight: vi.fn(async () => "R:1 Q:1 | "),
    });

    const exitCode = await runCli(
      ["status-right", "--separator", " | "],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.renderStatusRight).toHaveBeenCalledWith({
      separator: " | ",
    });
    expect(dependencies.stdoutBuffer.join("")).toBe("R:1 Q:1 | \n");
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });

  it("passes tmux context overrides to status-right", async () => {
    const dependencies = makeDependencies({
      renderStatusRight: vi.fn(async () => "R:1"),
    });

    const exitCode = await runCli(
      [
        "status-right",
        "--tmux-session",
        "pitch",
        "--tmux-window",
        "tmux-sidebar",
      ],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.renderStatusRight).toHaveBeenCalledWith({
      separator: undefined,
      tmuxSession: "pitch",
      tmuxWindow: "tmux-sidebar",
    });
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });

  it("renders raw Waybar agent status JSON", async () => {
    const payload = {
      text: "<span foreground=\"#7DAF7D\">R:1</span>",
      tooltip: "Pitch Agents",
      class: ["pitch-agents", "running"],
    };
    const dependencies = makeDependencies({
      renderWaybarStatus: vi.fn(async () => JSON.stringify(payload)),
    });

    const exitCode = await runCli(["waybar-status"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.renderWaybarStatus).toHaveBeenCalledWith();
    expect(JSON.parse(dependencies.stdoutBuffer.join(""))).toEqual(payload);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });

  it("streams Waybar agent status JSON in watch mode", async () => {
    const dependencies = makeDependencies({
      watchWaybarStatus: vi.fn(async (output) => {
        output.write("{\"text\":\"watch\"}\n");
      }),
    });

    const exitCode = await runCli(["waybar-status", "--watch"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.watchWaybarStatus).toHaveBeenCalledWith(
      dependencies.stdout,
    );
    expect(dependencies.renderWaybarStatus).not.toHaveBeenCalled();
    expect(dependencies.stdoutBuffer.join("")).toBe("{\"text\":\"watch\"}\n");
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });

  it("passes delete-branch-if-empty to deleteWorkspace", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["delete", "spike-auth", "--delete-branch-if-empty"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.deleteWorkspace).toHaveBeenCalledWith(
      {
        name: "spike-auth",
        force: undefined,
        delete_branch_if_empty: true,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("supports -d as a short alias for delete-branch-if-empty", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["delete", "spike-auth", "-d"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.deleteWorkspace).toHaveBeenCalledWith(
      {
        name: "spike-auth",
        force: undefined,
        delete_branch_if_empty: true,
      },
      makeConfig(),
      {
        reportWarning: expect.any(Function),
      },
    );
  });

  it("rejects values for presence-only boolean flags", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      [
        "create",
        "--pr",
        "700",
        "--slug",
        "default-aas",
        "--skip-prompt=false",
      ],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.stderrBuffer.join("")).toContain(
      "pitch: Option --skip-prompt does not take a value.",
    );
  });

  it("rejects the removed keep-worktree flag", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(
      ["close", "pr-700-default-aas", "--keep-worktree"],
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(dependencies.stderrBuffer.join("")).toContain(
      "pitch: Unknown option: --keep-worktree",
    );
  });

  it.each([[], ["--help"], ["help"]])("prints the overview only for root help %j", async (...args) => {
    const dependencies = makeDependencies();
    expect(await runCli(args, dependencies)).toBe(0);
    const output = dependencies.stdoutBuffer.join("");
    expect(output).toContain("Commands:");
    expect(output).toContain("Run pitch <command> --help");
    expect(output).not.toContain("--additional-dir PATH");
  });

  it.each([["workspace"], ["workspace", "--help"], ["help", "workspace"]])("explains the workspace prefix for %j", async (...args) => {
    const dependencies = makeDependencies();
    expect(await runCli(args, dependencies)).toBe(0);
    const output = dependencies.stdoutBuffer.join("");
    expect(output).toContain("Optional prefix for Pitch commands");
    expect(output).toContain("pitch workspace show NAME    = pitch show NAME");
    expect(output).not.toContain("Commands:");
    expect(output).not.toContain("--issue");
  });

  it.each([["show", "--help"], ["help", "show"], ["workspace", "show", "--help"]])("prints focused command help for %j", async (...args) => {
    const dependencies = makeDependencies();
    expect(await runCli(args, dependencies)).toBe(0);
    const output = dependencies.stdoutBuffer.join("");
    expect(output).toContain("Show saved workspace details");
    expect(output).toContain("show <name>");
    expect(output).toContain("--json");
    expect(output).not.toContain("Commands:");
    expect(output).not.toContain("--repo");
    expect(dependencies.getWorkspace).not.toHaveBeenCalled();
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });

  it("focuses provider list help on inventory flags", async () => {
    const dependencies = makeDependencies();
    expect(await runCli(["list", "konnect_org", "--help"], dependencies)).toBe(0);
    const output = dependencies.stdoutBuffer.join("");
    expect(output).toContain("--orphaned");
    expect(output).toContain("--verify");
    expect(output).not.toContain("--sort");
    expect(output).not.toContain("--status");
    expect(dependencies.listProvisionerInventory).not.toHaveBeenCalled();
  });

  it.each(["create", "agents", "agents-popup", "jump", "agent-status", "agent-error", "list",
    "get", "resume", "restart", "move", "rename", "close", "delete", "refresh", "cleanup",
    "prune", "status-right", "waybar-status", "view", "completion"])("provides focused help for %s", async (command) => {
    const dependencies = makeDependencies();
    expect(await runCli([command, "--help"], dependencies)).toBe(0);
    const output = dependencies.stdoutBuffer.join("");
    expect(output).toContain("Usage:");
    expect(output).toContain(`pitch ${command}`);
    expect(output).toContain("--help");
    expect(output).not.toContain("Commands:");
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });

  it("shows create help for implicit creation and rejects unknown help topics", async () => {
    const dependencies = makeDependencies();
    expect(await runCli(["--issue", "42", "--help"], dependencies)).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toContain("Create a workspace");
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(await runCli(["help", "--name", "example"], dependencies)).toBe(0);
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(await runCli(["unknown", "--help"], dependencies)).toBe(1);
    expect(dependencies.stderrBuffer.join("")).toContain("Unknown command: unknown");
  });

  it("prints zsh completion script", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["completion", "zsh"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toContain("#compdef pitch");
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "pitch __complete-workspaces",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "pitch __complete-tmux-sessions",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "pitch __complete-contexts",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'delete[Delete a workspace]'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'rename[Rename a workspace and its tmux window]'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "    close)",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "    delete)",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "    rename)",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "_pitch_complete_workspace_target",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "_pitch_dispatch \"${words[2]}\" 2",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      'words=("${words[@]:$(( command_index - 1 ))}")',
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "if [[ \"${words[2]}\" == --* ]]; then",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "_pitch_dispatch \"create\" 1",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "if [[ \"${words[3]}\" == --* ]]; then",
    );
    expect(dependencies.stdoutBuffer.join("")).not.toContain(
      "'-d[Delete the local branch only when it is unchanged from base and not pushed]'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'--name[Ad hoc workspace name]:name:'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'--branch[Ad hoc git branch name]:branch:'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'--session-id[Resume an existing agent session id]:session id:_pitch_sessions'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'--to[Target tmux session]:session:_pitch_tmux_sessions'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'--tmux-session[Target tmux session]:session:_pitch_tmux_sessions'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'--reset-session[Start a new agent session instead of resuming]'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "'--context[Repository launch context]:context:_pitch_contexts'",
    );
  });

  it("prints workspace names for completion", async () => {
    const dependencies = makeDependencies({
      listWorkspaces: vi.fn(async () => [
        makeWorkspaceSummary(),
        makeWorkspaceSummary({
          name: "gh-42-fix-bug",
          source_kind: "issue",
          source_number: 42,
          tmux_window: "gh-42-fix-bug",
        }),
      ]),
    });

    const exitCode = await runCli(
      ["__complete-workspaces"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toBe(
      "pr-700-default-aas\ngh-42-fix-bug\n",
    );
  });

  it("prints tmux session names for completion", async () => {
    const dependencies = makeDependencies({
      listTmuxSessions: vi.fn(async () => ["kongctl", "kongctl-aigw"]),
    });

    const exitCode = await runCli(
      ["__complete-tmux-sessions"],
      dependencies,
    );

    expect(exitCode).toBe(0);
    expect(dependencies.listTmuxSessions).toHaveBeenCalledTimes(1);
    expect(dependencies.stdoutBuffer.join("")).toBe(
      "kongctl\nkongctl-aigw\n",
    );
  });

  it("prints configured repository contexts for completion", async () => {
    const config = makeConfig();
    config.repos["kong/kongctl"].contexts = {
      "e2e-tech": { env: {}, env_from_files: {} },
      "e2e-com": { env: {}, env_from_files: {} },
    };
    const dependencies = makeDependencies({
      loadConfig: vi.fn(async () => config),
    });

    const exitCode = await runCli(["__complete-contexts"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toBe("e2e-com\ne2e-tech\n");
  });

  it("fails on unknown commands", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["launch"], dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.stderrBuffer.join("")).toContain(
      "pitch: Unknown command: launch",
    );
  });
});
