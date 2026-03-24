import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

function fixture(name: string): string {
  return join(fixtures, name);
}

describe("loadConfig", () => {
  describe("file handling", () => {
    it("returns defaults when file does not exist", async () => {
      const config = await loadConfig("/nonexistent/path/config.yaml");
      expect(config.defaults.base_branch).toBe("main");
      expect(config.defaults.worktree_root).toBe("~/.local/share/worktrees");
      expect(config.defaults.repo).toBeUndefined();
      expect(config.defaults.agent).toBeUndefined();
      expect(config.repos).toEqual({});
      expect(config.agents).toEqual({});
    });

    it("returns defaults for an empty file", async () => {
      const config = await loadConfig(fixture("empty-config.yaml"));
      expect(config.defaults.base_branch).toBe("main");
      expect(config.defaults.worktree_root).toBe("~/.local/share/worktrees");
      expect(config.repos).toEqual({});
      expect(config.agents).toEqual({});
    });

    it("throws ConfigError for malformed YAML", async () => {
      await expect(loadConfig(fixture("bad-yaml.yaml"))).rejects.toThrow(
        ConfigError,
      );
      await expect(loadConfig(fixture("bad-yaml.yaml"))).rejects.toThrow(
        /parse YAML/,
      );
    });
  });

  describe("null YAML keys", () => {
    it("treats null-valued keys as defaults", async () => {
      const config = await loadConfig(fixture("null-keys-config.yaml"));
      expect(config.defaults.base_branch).toBe("main");
      expect(config.defaults.worktree_root).toBe("~/.local/share/worktrees");
      expect(config.repos).toEqual({});
      expect(config.agents).toEqual({});
    });
  });

  describe("full config parsing", () => {
    it("parses all fields from a complete config", async () => {
      const config = await loadConfig(fixture("full-config.yaml"));

      expect(config.defaults.repo).toBe("kong/kongctl");
      expect(config.defaults.agent).toBe("codex");
      expect(config.defaults.base_branch).toBe("main");
      expect(config.defaults.worktree_root).toBe("~/.local/share/worktrees");

      expect(config.repos["kong/kongctl"]).toEqual({
        default_agent: "claude-enterprise",
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        agent_defaults: {
          runtime: undefined,
          args: ["--add-dir", "/home/rspurgeon/go"],
          env: {},
        },
        agent_overrides: {
          codex: {
            runtime: undefined,
            args: ["--add-dir", "/home/rspurgeon/.config/kongctl"],
            env: {},
          },
          "claude-personal": {
            runtime: undefined,
            args: [],
            env: {
              CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
            },
          },
        },
      });

      expect(config.agents["codex"]).toEqual({
        type: "codex",
        runtime: "native",
        args: [
          "--model",
          "gpt-5.4",
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ],
        env: { CODEX_HOME: "~/.codex" },
      });

      expect(config.agents["claude-enterprise"]).toEqual({
        type: "claude",
        runtime: "docker",
        args: [
          "--model",
          "sonnet",
          "--permission-mode",
          "bypassPermissions",
        ],
        env: { CLAUDE_CONFIG_DIR: "~/.claude" },
      });

      expect(config.agents["claude-personal"]).toEqual({
        type: "claude",
        runtime: "native",
        env: { CLAUDE_CONFIG_DIR: "~/.claude-personal" },
        args: ["--model", "opus"],
      });

      expect(config.agents["codex-api"]).toEqual({
        type: "codex",
        runtime: "native",
        env: {
          CODEX_HOME: "~/.codex-api",
          OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
        },
        args: [],
      });

      expect(config.agents["opencode"]).toEqual({
        type: "opencode",
        runtime: "native",
        env: {
          OPENCODE_CONFIG_DIR: "~/.config/opencode",
        },
        args: ["--agent", "build"],
      });
    });

    it("derives repo worktree_base and tmux_session when omitted", async () => {
      const config = await loadConfig(fixture("derived-repo-config.yaml"));

      expect(config.repos["kong/kongctl"]).toEqual({
        default_agent: "claude-enterprise",
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        agent_defaults: {
          runtime: undefined,
          args: [],
          env: {},
        },
        agent_overrides: {},
      });
    });

    it("preserves tilde paths as-is", async () => {
      const config = await loadConfig(fixture("full-config.yaml"));
      expect(config.repos["kong/kongctl"].main_worktree).toBe(
        "~/dev/kong/kongctl",
      );
    });

    it("preserves env var references as literal strings", async () => {
      const config = await loadConfig(fixture("full-config.yaml"));
      expect(config.agents["codex-api"].env["OPENAI_API_KEY"]).toBe(
        "${OPENAI_API_KEY_SECONDARY}",
      );
    });
  });

  describe("defaults", () => {
    it("fills in defaults for partial config", async () => {
      const config = await loadConfig(fixture("minimal-config.yaml"));
      expect(config.defaults.repo).toBe("kong/kongctl");
      expect(config.defaults.base_branch).toBe("main");
      expect(config.defaults.worktree_root).toBe("~/.local/share/worktrees");
      expect(config.defaults.agent).toBeUndefined();
      expect(config.repos).toEqual({});
      expect(config.agents).toEqual({});
    });
  });

  describe("unsupported config shapes", () => {
    it("rejects agent defaults maps in favor of args arrays", async () => {
      await expect(
        loadConfig(fixture("unsupported-agent-defaults-config.yaml")),
      ).rejects.toThrow(ConfigError);
    });
  });

  describe("validation errors", () => {
    it("rejects unknown agent references in defaults and repos", async () => {
      await expect(
        loadConfig(fixture("unknown-agent-reference-config.yaml")),
      ).rejects.toThrow(ConfigError);
      await expect(
        loadConfig(fixture("unknown-agent-reference-config.yaml")),
      ).rejects.toThrow(/Unknown agent reference: missing-agent/);
    });

    it("throws ConfigError for invalid field types", async () => {
      await expect(loadConfig(fixture("invalid-config.yaml"))).rejects.toThrow(
        ConfigError,
      );
    });

    it("includes field path in validation error message", async () => {
      try {
        await loadConfig(fixture("invalid-config.yaml"));
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        const message = (err as ConfigError).message;
        expect(message).toMatch(/Invalid config/);
        expect(message).toMatch(/defaults\.base_branch/);
      }
    });
  });
});
