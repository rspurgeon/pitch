import { afterEach, describe, expect, it } from "vitest";
import type { PitchConfig } from "../config.js";
import {
  AgentLauncherError,
  buildAgentResumeCommand,
  buildAgentStartCommand,
  claudeLauncher,
  codexLauncher,
  opencodeLauncher,
  setExecutableReadDirectoryResolverForTests,
} from "../agent-launcher.js";

function buildCodexPathOverride(path: string): string {
  return `shell_environment_policy.set={PATH="${path
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"}`;
}

function makeConfig(): PitchConfig {
  return {
    defaults: {
      repo: "kong/kongctl",
      agent: "codex",
      base_branch: "main",
      worktree_root: "~/.local/share/worktrees",
    },
    bootstrap_prompts: {},
    repos: {
      "kong/kongctl": {
        default_agent: "claude-enterprise",
        sandbox: undefined,
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        additional_paths: ["/home/rspurgeon/go"],
        bootstrap_prompts: {},
        agent_defaults: {
          args: [],
          env: {
            GO_SRC: "/home/rspurgeon/go",
          },
        },
        agent_overrides: {
          codex: {
            args: [
              "--add-dir",
              "/home/rspurgeon/.config/kongctl",
            ],
            env: {
              KONGCTL_CONFIG_DIR: "/home/rspurgeon/.config/kongctl",
            },
          },
          "claude-personal": {
            args: [],
            env: {},
          },
          "codex-api": {
            args: ["--search"],
            env: {
              OPENAI_BASE_URL: "https://api.example.invalid",
            },
          },
        },
      },
    },
    environments: {
      "sandbox-vm": {
        kind: "vm-ssh",
        ssh_host: "sandbox.internal",
        ssh_user: "pitch",
        ssh_port: 2222,
        ssh_options: ["-o", "StrictHostKeyChecking=accept-new"],
        guest_workspace_root: "/srv/pitch/workspaces",
        shared_paths: [
          {
            host_path: "/home/rspurgeon/go",
            guest_path: "/srv/shared/go",
            mode: "ro",
          },
          {
            host_path: "/home/rspurgeon/.config/kongctl",
            guest_path: "/srv/shared/kongctl",
            mode: "ro",
          },
        ],
        bootstrap: {
          mise_install: true,
        },
      },
    },
    sandboxes: {
      kongctl: {
        provider: "nono",
        profiles: {
          codex: "/srv/nono/kongctl-codex.json",
        },
        network_profile: "docs-and-github",
        capability_elevation: true,
        rollback: true,
      },
      locked: {
        provider: "nono",
        profile: "/srv/nono/kongctl.toml",
        profiles: {
          codex: "/srv/nono/kongctl-codex.toml",
        },
        capability_elevation: false,
        rollback: false,
      },
    },
    agents: {
      "claude-enterprise": {
        type: "claude",
        args: [
          "--model",
          "sonnet",
          "--permission-mode",
          "bypassPermissions",
        ],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude",
        },
      },
      "claude-personal": {
        type: "claude",
        args: ["--model", "opus"],
        env: {
          CLAUDE_CONFIG_DIR: "~/.claude-personal",
        },
      },
      codex: {
        type: "codex",
        args: [
          "--model",
          "gpt-5.4",
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ],
        env: {
          CODEX_HOME: "~/.codex",
        },
      },
      "codex-api": {
        type: "codex",
        args: [],
        env: {
          CODEX_HOME: "~/.codex-api",
          OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
        },
      },
      opencode: {
        type: "opencode",
        args: ["--agent", "build"],
        env: {
          OPENCODE_CONFIG_DIR: "~/.config/opencode",
        },
      },
      "opencode-attach": {
        type: "opencode",
        args: [
          "attach",
          "http://localhost:4096",
          "--dir",
          ".",
        ],
        env: {
          OPENCODE_SERVER_PASSWORD: "secret",
        },
      },
      "opencode-attach-continue": {
        type: "opencode",
        args: [
          "attach",
          "http://localhost:4096",
          "--continue",
          "--agent",
          "build",
          "--dir",
          ".",
        ],
        env: {
          OPENCODE_SERVER_PASSWORD: "secret",
        },
      },
    },
  };
}

describe("agent launcher", () => {
  afterEach(() => {
    setExecutableReadDirectoryResolverForTests(null);
  });

  it("builds a Claude start command with generated session id", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-enterprise",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.agent_name).toBe("claude-enterprise");
    expect(command.agent_type).toBe("claude");
    expect(command.command).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--session-id",
      command.session_id!,
      "--name",
      "gh-565-fix-validation",
    ]);
    expect(command.env).toEqual({
      CLAUDE_CONFIG_DIR: "~/.claude",
    });
    expect(command.post_launch_prompt).toBeUndefined();
  });

  it("appends an initial prompt to interactive Claude start commands", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-enterprise",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      initial_prompt: "Read the issue and wait.",
      session_id: "claude-session",
    });

    expect(command.command).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--session-id",
      "claude-session",
      "--name",
      "gh-565-fix-validation",
      "Read the issue and wait.",
    ]);
  });

  it("builds a Codex start command with layered overrides", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      override_args: [
        "--model",
        "gpt-5.5",
        "--ask-for-approval",
        "never",
        "--cd",
        "/tmp/ignored",
      ],
    });

    expect(command.agent_type).toBe("codex");
    expect(command.command).toEqual([
      "codex",
      "--model",
      "gpt-5.4",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--add-dir",
      "/home/rspurgeon/go",
      "--add-dir",
      "/home/rspurgeon/.config/kongctl",
      "--model",
      "gpt-5.5",
      "--ask-for-approval",
      "never",
      "--cd",
      "/tmp/worktree",
    ]);
    expect(command.session_id).toBeUndefined();
    expect(command.env).toEqual({
      CODEX_HOME: "~/.codex",
      GO_SRC: "/home/rspurgeon/go",
      KONGCTL_CONFIG_DIR: "/home/rspurgeon/.config/kongctl",
    });
    expect(command.post_launch_prompt).toBeUndefined();
  });

  it("appends an initial prompt to interactive Codex start commands", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      initial_prompt: "Read the issue and wait.",
    });

    expect(command.command).toEqual([
      "codex",
      "--model",
      "gpt-5.4",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "--cd",
      "/tmp/worktree",
      "Read the issue and wait.",
    ]);
  });

  it("builds a Claude resume command", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "claude-enterprise",
      workspace_name: "gh-565-fix-validation",
      session_id: "session-123",
    });

    expect(command.command).toEqual(["claude", "--resume", "session-123"]);
    expect(command.session_id).toBe("session-123");
  });

  it("builds a Codex resume command", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "codex",
      workspace_name: "gh-565-fix-validation",
      session_id: "session-456",
    });

    expect(command.command).toEqual(["codex", "resume", "session-456"]);
    expect(command.session_id).toBe("session-456");
  });

  it("builds an OpenCode start command in the target worktree", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "opencode",
      opencode_config_path: "/tmp/pitch-opencode/gh-565-fix-validation.json",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      override_args: [
        "--model",
        "openrouter/anthropic/claude-sonnet-4",
        "--session",
        "ignored",
      ],
    });

    expect(command.agent_type).toBe("opencode");
    expect(command.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "--model",
      "openrouter/anthropic/claude-sonnet-4",
      "/tmp/worktree",
    ]);
    expect(command.session_id).toBeUndefined();
    expect(command.env).toEqual({
      OPENCODE_CONFIG: "/tmp/pitch-opencode/gh-565-fix-validation.json",
      OPENCODE_CONFIG_DIR: "~/.config/opencode",
    });
    expect(command.post_launch_prompt).toBeUndefined();
  });

  it("passes bootstrap prompts through normal OpenCode start commands", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "opencode",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      initial_prompt: "Read the issue and wait.",
    });

    expect(command.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "--prompt",
      "Read the issue and wait.",
      "/tmp/worktree",
    ]);
    expect(command.post_launch_prompt).toBeUndefined();
  });

  it("builds an OpenCode resume command", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "opencode",
      opencode_config_path: "/tmp/pitch-opencode/gh-565-fix-validation.json",
      workspace_name: "gh-565-fix-validation",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "--session",
      "ses_123",
    ]);
    expect(command.session_id).toBe("ses_123");
    expect(command.env).toEqual({
      OPENCODE_CONFIG: "/tmp/pitch-opencode/gh-565-fix-validation.json",
      OPENCODE_CONFIG_DIR: "~/.config/opencode",
    });
  });

  it("builds OpenCode attach-mode start and injects the worktree dir", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "opencode-attach",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--dir",
      "/tmp/worktree",
    ]);
    expect(command.env).toEqual({
      OPENCODE_SERVER_PASSWORD: "secret",
    });
  });

  it("defers bootstrap prompts for OpenCode attach mode until after launch", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "opencode-attach",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      initial_prompt: "Read the issue and wait.",
    });

    expect(command.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--dir",
      "/tmp/worktree",
    ]);
    expect(command.post_launch_prompt).toBe("Read the issue and wait.");
  });

  it("builds OpenCode attach-mode resume and preserves the attach target", () => {
    const config = makeConfig();

    const command = buildAgentResumeCommand({
      config,
      agent: "opencode-attach",
      workspace_name: "gh-565-fix-validation",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--dir",
      "/tmp/worktree",
      "--session",
      "ses_123",
    ]);
    expect(command.env).toEqual({
      OPENCODE_SERVER_PASSWORD: "secret",
    });
  });

  it("strips valueless OpenCode continue flags without dropping following args", () => {
    const config = makeConfig();

    const startCommand = buildAgentStartCommand({
      config,
      agent: "opencode-attach-continue",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(startCommand.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--agent",
      "build",
      "--dir",
      "/tmp/worktree",
    ]);

    const resumeCommand = buildAgentResumeCommand({
      config,
      agent: "opencode-attach-continue",
      workspace_name: "gh-565-fix-validation",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(resumeCommand.command).toEqual([
      "opencode",
      "attach",
      "http://localhost:4096",
      "--agent",
      "build",
      "--dir",
      "/tmp/worktree",
      "--session",
      "ses_123",
    ]);
  });

  it("builds a selected named Claude agent with repo overrides", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-personal",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      session_id: "claude-session",
    });

    expect(command.agent_name).toBe("claude-personal");
    expect(command.agent_type).toBe("claude");
    expect(command.command).toEqual([
      "claude",
      "--model",
      "opus",
      "--add-dir",
      "/home/rspurgeon/go",
      "--session-id",
      "claude-session",
      "--name",
      "gh-565-fix-validation",
    ]);
    expect(command.env).toEqual({
      CLAUDE_CONFIG_DIR: "~/.claude-personal",
      GO_SRC: "/home/rspurgeon/go",
    });
  });

  it("forwards selected agent env into Codex commands", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex-api",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.agent_type).toBe("codex");
    expect(command.command).toEqual([
      "codex",
      "--add-dir",
      "/home/rspurgeon/go",
      "--search",
      "--cd",
      "/tmp/worktree",
    ]);
    expect(command.env).toEqual({
      CODEX_HOME: "~/.codex-api",
      GO_SRC: "/home/rspurgeon/go",
      OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
      OPENAI_BASE_URL: "https://api.example.invalid",
    });
  });

  it("wraps agent commands for vm-ssh environments", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      environment: "sandbox-vm",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/srv/pitch/workspaces/gh-565-fix-validation",
      host_worktree_path: "/tmp/worktree",
    });

    expect(command.environment_kind).toBe("vm-ssh");
    expect(command.pane_process_name).toBe("ssh");
    expect(command.pane_reuse_command).toContain("[pitch] Agent exited");
    expect(command.host_marker_path).toBe(
      "/tmp/.pitch-state/gh-565-fix-validation/vm-agent-active",
    );
    expect(command.env).toEqual({});
    expect(command.agent_env).toEqual({
      CODEX_HOME: "~/.codex",
      GO_SRC: "/srv/shared/go",
      KONGCTL_CONFIG_DIR: "/srv/shared/kongctl",
    });
    expect(command.command.slice(0, 6)).toEqual([
      "ssh",
      "-tt",
      "-p",
      "2222",
      "-o",
      "StrictHostKeyChecking=accept-new",
    ]);
    expect(command.command[6]).toBe("pitch@sandbox.internal");
    expect(command.command[7]).toContain("bash -lc '");
    expect(command.command[7]).toContain("exec bash -li");
    expect(command.command[7]).toContain(
      "/srv/pitch/workspaces/gh-565-fix-validation",
    );
    expect(command.command[7]).toContain("mise install");
    expect(command.command[7]).toContain("clear &&");
    expect(command.command[7]).toContain("'codex'");
    expect(command.command[7]).toContain("/srv/shared/go");
    expect(command.command[7]).toContain("/srv/shared/kongctl");
    expect(command.pane_reuse_command).toContain("clear &&");
  });

  it("wraps host Codex commands with nono when a sandbox is selected", () => {
    const config = makeConfig();
    setExecutableReadDirectoryResolverForTests(() => [
      "/home/rspurgeon/.local/share/mise/installs/codex/0.118.0",
    ]);

    const command = buildAgentStartCommand({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      sandbox: "kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.pane_process_name).toBe("nono");
    expect(command.command).toEqual([
      "nono",
      "run",
      "--profile",
      "/srv/nono/kongctl-codex.json",
      "--workdir",
      "/tmp/worktree",
      "--allow-cwd",
      "--read",
      "/home/rspurgeon/.local/share/mise/installs/codex/0.118.0",
      "--read",
      "/home/rspurgeon/.config/mise",
      "--read",
      "/home/rspurgeon/.cache/mise",
      "--read",
      "/home/rspurgeon/.local/bin",
      "--read",
      "/home/rspurgeon/.local/share/mise/bin",
      "--write",
      "/home/rspurgeon/.cache/mise",
      "--network-profile",
      "docs-and-github",
      "--capability-elevation",
      "--rollback",
      "--",
      "codex",
      "--model",
      "gpt-5.4",
      "--ask-for-approval",
      "on-request",
      "--add-dir",
      "/home/rspurgeon/go",
      "--add-dir",
      "/home/rspurgeon/.config/kongctl",
      "-c",
      "shell_environment_policy.inherit=all",
      "-c",
      buildCodexPathOverride(command.agent_env.PATH),
      "--sandbox",
      "danger-full-access",
      "--cd",
      "/tmp/worktree",
    ]);
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/share/mise/bin",
    );
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/share/mise/shims",
    );
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/bin",
    );
    expect(command.agent_env.GOPATH).toBe(undefined);
    expect(command.agent_env.GOMODCACHE).toBe(undefined);
    expect(command.agent_env.GOCACHE).toBe(undefined);
    expect(command.agent_env.TMPDIR).toBe(undefined);
    expect(command.agent_env.GOTMPDIR).toBe(undefined);
    expect(command.agent_env.GOLANGCI_LINT_CACHE).toBe(undefined);
    expect(command.agent_env.GOFLAGS).toBe(undefined);
  });

  it("uses explicit sandbox profiles verbatim", () => {
    const config = makeConfig();
    setExecutableReadDirectoryResolverForTests(() => [
      "/home/rspurgeon/.local/share/mise/installs/codex/0.118.0",
    ]);

    const command = buildAgentResumeCommand({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      sandbox: "locked",
      workspace_name: "gh-565-fix-validation",
      session_id: "session-123",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "nono",
      "run",
      "--profile",
      "/srv/nono/kongctl-codex.toml",
      "--workdir",
      "/tmp/worktree",
      "--allow-cwd",
      "--read",
      "/home/rspurgeon/.local/share/mise/installs/codex/0.118.0",
      "--read",
      "/home/rspurgeon/.config/mise",
      "--read",
      "/home/rspurgeon/.cache/mise",
      "--read",
      "/home/rspurgeon/.local/bin",
      "--read",
      "/home/rspurgeon/.local/share/mise/bin",
      "--write",
      "/home/rspurgeon/.cache/mise",
      "--",
      "codex",
      "-c",
      "shell_environment_policy.inherit=all",
      "-c",
      buildCodexPathOverride(command.agent_env.PATH),
      "--sandbox",
      "danger-full-access",
      "resume",
      "session-123",
    ]);
  });

  it("falls back to sandbox.profile when no agent-specific profile exists", () => {
    const config = makeConfig();
    setExecutableReadDirectoryResolverForTests(() => [
      "/home/rspurgeon/.local/share/mise/installs/opencode/1.3.0",
    ]);

    const command = buildAgentStartCommand({
      config,
      agent: "opencode",
      repo: "kong/kongctl",
      sandbox: "locked",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command.slice(0, 6)).toEqual([
      "nono",
      "run",
      "--profile",
      "/srv/nono/kongctl.toml",
      "--workdir",
      "/tmp/worktree",
    ]);
  });

  it("wraps guest agent commands with nono inside vm-ssh sessions", () => {
    const config = makeConfig();
    setExecutableReadDirectoryResolverForTests(() => [
      "/home/rspurgeon/.local/share/mise/installs/codex/0.118.0",
    ]);

    const command = buildAgentStartCommand({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      sandbox: "kongctl",
      environment: "sandbox-vm",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/srv/pitch/workspaces/gh-565-fix-validation",
      host_worktree_path: "/tmp/worktree",
    });

    expect(command.pane_process_name).toBe("ssh");
    expect(command.command[7]).toContain("env CODEX_HOME");
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/share/mise/bin",
    );
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/share/mise/shims",
    );
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/bin",
    );
    expect(command.agent_env.GOPATH).toBe(undefined);
    expect(command.agent_env.GOMODCACHE).toBe(undefined);
    expect(command.agent_env.GOCACHE).toBe(undefined);
    expect(command.agent_env.TMPDIR).toBe(undefined);
    expect(command.agent_env.GOTMPDIR).toBe(undefined);
    expect(command.agent_env.GOLANGCI_LINT_CACHE).toBe(undefined);
    expect(command.agent_env.GOFLAGS).toBe(undefined);
    expect(command.command[7]).toContain("'\"'\"'nono'\"'\"' '\"'\"'run'\"'\"'");
    expect(command.command[7]).toContain(
      "'\"'\"'--profile'\"'\"' '\"'\"'/srv/nono/kongctl-codex.json'\"'\"'",
    );
    expect(command.command[7]).toContain(
      "'\"'\"'--workdir'\"'\"' '\"'\"'/srv/pitch/workspaces/gh-565-fix-validation'\"'\"'",
    );
    expect(command.command[7]).toContain(
      "'\"'\"'-c'\"'\"' '\"'\"'shell_environment_policy.inherit=all'\"'\"'",
    );
    expect(command.command[7]).toContain(
      "shell_environment_policy.set={PATH=",
    );
    expect(command.command[7]).toContain(
      "'\"'\"'--sandbox'\"'\"' '\"'\"'danger-full-access'\"'\"'",
    );
  });

  it("adds codex toolchain PATH for vm-ssh environment resumes", () => {
    const config = makeConfig();
    setExecutableReadDirectoryResolverForTests(() => [
      "/home/rspurgeon/.local/share/mise/installs/codex/0.118.0",
    ]);

    const command = buildAgentResumeCommand({
      config,
      agent: "codex",
      repo: "kong/kongctl",
      sandbox: "kongctl",
      environment: "sandbox-vm",
      workspace_name: "gh-565-fix-validation",
      session_id: "session-123",
      worktree_path: "/srv/pitch/workspaces/gh-565-fix-validation",
      host_worktree_path: "/tmp/worktree",
    });

    expect(command.environment_kind).toBe("vm-ssh");
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/share/mise/bin",
    );
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/share/mise/shims",
    );
    expect(command.agent_env.PATH).toContain(
      "/home/rspurgeon/.local/bin",
    );
    expect(command.agent_env.GOPATH).toBe(undefined);
    expect(command.agent_env.GOMODCACHE).toBe(undefined);
    expect(command.agent_env.GOCACHE).toBe(undefined);
    expect(command.agent_env.TMPDIR).toBe(undefined);
    expect(command.agent_env.GOTMPDIR).toBe(undefined);
    expect(command.agent_env.GOLANGCI_LINT_CACHE).toBe(undefined);
    expect(command.agent_env.GOFLAGS).toBe(undefined);
    expect(command.command[7]).toContain(
      "'\"'\"'-c'\"'\"' '\"'\"'shell_environment_policy.inherit=all'\"'\"'",
    );
    expect(command.command[7]).toContain(
      "shell_environment_policy.set={PATH=",
    );
    expect(command.command[7]).toContain(
      "'\"'\"'--sandbox'\"'\"' '\"'\"'danger-full-access'\"'\"'",
    );
  });

  it("rejects Claude bypassPermissions when sandboxing is enabled", () => {
    const config = makeConfig();

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "claude-enterprise",
        sandbox: "kongctl",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
      }),
    ).toThrow(
      "Claude cannot use --permission-mode bypassPermissions when sandboxing is enabled",
    );
  });

  it("does not let Claude overrides replace required workspace flags", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "claude-enterprise",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
      session_id: "pitch-session",
      override_args: [
        "--model",
        "opus",
        "--session-id",
        "user-session",
        "--cd",
        "/tmp/ignored",
        "--name",
        "wrong-name",
        "-n",
        "wrong-name-short",
      ],
    });

    expect(command.command).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "opus",
      "--session-id",
      "pitch-session",
      "--name",
      "gh-565-fix-validation",
    ]);
  });

  it("does not warn for OpenCode repo additional_paths", () => {
    const config = makeConfig();

    const command = buildAgentStartCommand({
      config,
      agent: "opencode",
      repo: "kong/kongctl",
      workspace_name: "gh-565-fix-validation",
      worktree_path: "/tmp/worktree",
    });

    expect(command.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "/tmp/worktree",
    ]);
    expect(command.warnings).toEqual([]);
  });

  it("throws for unknown agent names", () => {
    const config = makeConfig();

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "unknown-agent",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
      }),
    ).toThrow(AgentLauncherError);
  });

  it("throws when the selected named agent is not configured", () => {
    const config = makeConfig();
    delete config.agents["claude-enterprise"];

    expect(() =>
      buildAgentStartCommand({
        config,
        agent: "claude-enterprise",
        workspace_name: "gh-565-fix-validation",
        worktree_path: "/tmp/worktree",
      }),
    ).toThrow("Agent is not configured: claude-enterprise");
  });

  it("exposes concrete launchers for direct use", () => {
    const config = makeConfig();

    const claude = claudeLauncher.buildResumeCommand({
      config,
      agent: "claude-enterprise",
      workspace_name: "gh-565-fix-validation",
      session_id: "claude-session",
    });
    const codex = codexLauncher.buildResumeCommand({
      config,
      agent: "codex",
      workspace_name: "gh-565-fix-validation",
      session_id: "codex-session",
    });
    const opencode = opencodeLauncher.buildResumeCommand({
      config,
      agent: "opencode",
      workspace_name: "gh-565-fix-validation",
      session_id: "ses_123",
      worktree_path: "/tmp/worktree",
    });

    expect(claude.command).toEqual(["claude", "--resume", "claude-session"]);
    expect(codex.command).toEqual(["codex", "resume", "codex-session"]);
    expect(opencode.command).toEqual([
      "opencode",
      "--agent",
      "build",
      "--session",
      "ses_123",
    ]);
  });
});
