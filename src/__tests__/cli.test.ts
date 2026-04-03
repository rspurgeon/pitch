import { describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "../cli.js";
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
    agents: {
      codex: {
        type: "codex",
        runtime: "native",
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
    agent_runtime: "native",
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
    loadConfig: vi.fn(async () => makeConfig()),
    createWorkspace: vi.fn(async () => makeWorkspaceRecord()),
    listWorkspaces: vi.fn(async () => [makeWorkspaceSummary()]),
    getWorkspace: vi.fn(async () => makeWorkspaceRecord()),
    resumeWorkspace: vi.fn(async () => makeWorkspaceRecord()),
    closeWorkspace: vi.fn(async () => makeWorkspaceRecord({ status: "closed" })),
    deleteWorkspace: vi.fn(async () => makeWorkspaceRecord({ status: "closed" })),
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
        slug: "default-aas",
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        skip_prompt: true,
        runtime: undefined,
        model: undefined,
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
        slug: undefined,
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        skip_prompt: undefined,
        runtime: undefined,
        model: undefined,
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
        slug: "default-aas",
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        skip_prompt: true,
        runtime: undefined,
        model: undefined,
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
        slug: undefined,
        base_branch: undefined,
        agent: undefined,
        environment: undefined,
        skip_prompt: undefined,
        runtime: undefined,
        model: undefined,
      },
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
        sync: undefined,
      },
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
        sync: true,
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
      },
      makeConfig(),
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "status: closed",
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

  it("prints help for an empty invocation", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli([], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "pitch [create] (--issue N | --pr N) [--slug SLUG] [options]",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "If --issue or --pr is provided without an explicit command, create is",
    );
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
      "'delete[Delete a workspace]'",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "    close)",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "    delete)",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "_pitch_complete_workspace_target",
    );
    expect(dependencies.stdoutBuffer.join("")).toContain(
      "_pitch_dispatch \"${words[2]}\" 2",
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

  it("fails on unknown commands", async () => {
    const dependencies = makeDependencies();

    const exitCode = await runCli(["launch"], dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.stderrBuffer.join("")).toContain(
      "pitch: Unknown command: launch",
    );
  });
});
