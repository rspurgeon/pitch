import { describe, expect, it } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  mapPathForEnvironment,
  resolveExecutionEnvironment,
  resolveWorkspacePaths,
} from "../execution-environment.js";

function makeConfig(): PitchConfig {
  return {
    defaults: {
      repo: "rspurgeon/pitch",
      agent: "codex",
      environment: "sandbox-vm",
      base_branch: "main",
      worktree_root: "~/.local/share/worktrees",
    },
    bootstrap_prompts: {},
    repos: {
      "rspurgeon/pitch": {
        default_agent: "codex",
        default_environment: "sandbox-vm",
        main_worktree: "/srv/pitch-host/repos/rspurgeon/pitch",
        worktree_base: "/srv/pitch-host/worktrees/rspurgeon/pitch",
        tmux_session: "pitch",
        additional_paths: ["/srv/shared/go"],
        bootstrap_prompts: {},
        agent_defaults: {
          args: [],
          env: {},
        },
        agent_overrides: {},
      },
    },
    environments: {
      "sandbox-vm": {
        kind: "vm-ssh",
        ssh_host: "pitch-sandbox",
        ssh_user: "pitch",
        ssh_options: [],
        guest_workspace_root: "/srv/pitch/workspaces",
        shared_paths: [
          {
            host_path: "/srv/pitch-host",
            guest_path: "/srv/pitch-host",
            mode: "rw",
          },
          {
            host_path: "/srv/shared/go",
            guest_path: "/srv/shared/go",
            mode: "ro",
          },
        ],
        bootstrap: {
          mise_install: true,
        },
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

describe("execution environment", () => {
  it("maps shared host worktree paths into the guest", () => {
    const config = makeConfig();
    const environment = resolveExecutionEnvironment(
      config,
      "rspurgeon/pitch",
      "sandbox-vm",
    );

    const paths = resolveWorkspacePaths(
      environment,
      "gh-37-vm-backed-environments",
      "/srv/pitch-host/worktrees/rspurgeon/pitch/gh-37-vm-backed-environments",
    );

    expect(paths).toEqual({
      host_worktree_path:
        "/srv/pitch-host/worktrees/rspurgeon/pitch/gh-37-vm-backed-environments",
      agent_worktree_path:
        "/srv/pitch-host/worktrees/rspurgeon/pitch/gh-37-vm-backed-environments",
      guest_worktree_path:
        "/srv/pitch-host/worktrees/rspurgeon/pitch/gh-37-vm-backed-environments",
    });
  });

  it("falls back to guest workspace root for unshared worktree paths", () => {
    const config = makeConfig();
    const environment = resolveExecutionEnvironment(
      config,
      "rspurgeon/pitch",
      "sandbox-vm",
    );

    const paths = resolveWorkspacePaths(
      environment,
      "gh-37-vm-backed-environments",
      "/tmp/worktrees/gh-37-vm-backed-environments",
    );

    expect(paths.guest_worktree_path).toBe(
      "/srv/pitch/workspaces/gh-37-vm-backed-environments",
    );
  });

  it("maps repo metadata paths through shared path definitions", () => {
    const config = makeConfig();
    const environment = resolveExecutionEnvironment(
      config,
      "rspurgeon/pitch",
      "sandbox-vm",
    );
    const workspacePaths = resolveWorkspacePaths(
      environment,
      "gh-37-vm-backed-environments",
      "/srv/pitch-host/worktrees/rspurgeon/pitch/gh-37-vm-backed-environments",
    );

    expect(
      mapPathForEnvironment(
        "/srv/pitch-host/repos/rspurgeon/pitch/.git/worktrees/gh-37-vm-backed-environments",
        environment,
        workspacePaths,
      ),
    ).toBe(
      "/srv/pitch-host/repos/rspurgeon/pitch/.git/worktrees/gh-37-vm-backed-environments",
    );
  });
});
