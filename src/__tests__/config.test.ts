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
      expect(config.defaults.repo).toBeUndefined();
      expect(config.defaults.agent).toBeUndefined();
      expect(config.repos).toEqual({});
      expect(config.agents).toEqual({});
      expect(config.agent_profiles).toEqual({});
    });

    it("returns defaults for an empty file", async () => {
      const config = await loadConfig(fixture("empty-config.yaml"));
      expect(config.defaults.base_branch).toBe("main");
      expect(config.repos).toEqual({});
      expect(config.agents).toEqual({});
      expect(config.agent_profiles).toEqual({});
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

  describe("full config parsing", () => {
    it("parses all fields from a complete config", async () => {
      const config = await loadConfig(fixture("full-config.yaml"));

      expect(config.defaults.repo).toBe("kong/kongctl");
      expect(config.defaults.agent).toBe("codex");
      expect(config.defaults.base_branch).toBe("main");

      expect(config.repos["kong/kongctl"]).toEqual({
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
      });

      expect(config.agents["codex"]).toEqual({
        runtime: "native",
        defaults: {
          model: "gpt-5.4",
          sandbox: "workspace-write",
          approval: "on-request",
        },
        env: { CODEX_HOME: "~/.codex" },
      });

      expect(config.agents["claude"]).toEqual({
        runtime: "docker",
        defaults: {
          model: "sonnet",
          permission_mode: "dangerously-skip-permissions",
        },
        env: { CLAUDE_CONFIG_DIR: "~/.claude" },
      });

      expect(config.agent_profiles["claude-personal"]).toEqual({
        agent: "claude",
        runtime: "native",
        env: { CLAUDE_CONFIG_DIR: "~/.claude-personal" },
        defaults: { model: "opus" },
      });

      expect(config.agent_profiles["codex-api"]).toEqual({
        agent: "codex",
        runtime: undefined,
        env: {
          CODEX_HOME: "~/.codex-api",
          OPENAI_API_KEY: "${OPENAI_API_KEY_SECONDARY}",
        },
        defaults: {},
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
      expect(config.agent_profiles["codex-api"].env["OPENAI_API_KEY"]).toBe(
        "${OPENAI_API_KEY_SECONDARY}",
      );
    });
  });

  describe("defaults", () => {
    it("fills in defaults for partial config", async () => {
      const config = await loadConfig(fixture("minimal-config.yaml"));
      expect(config.defaults.repo).toBe("kong/kongctl");
      expect(config.defaults.base_branch).toBe("main");
      expect(config.defaults.agent).toBeUndefined();
      expect(config.repos).toEqual({});
      expect(config.agents).toEqual({});
      expect(config.agent_profiles).toEqual({});
    });
  });

  describe("validation errors", () => {
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
        expect((err as ConfigError).message).toMatch(/Invalid config/);
      }
    });
  });
});
