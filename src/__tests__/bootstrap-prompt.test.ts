import { describe, expect, it } from "vitest";
import type { PitchConfig } from "../config.js";
import { buildBootstrapPrompt } from "../bootstrap-prompt.js";

function makeConfig(): PitchConfig {
  return {
    defaults: {
      repo: "kong/kongctl",
      agent: "codex",
      base_branch: "main",
      worktree_root: "~/.local/share/worktrees",
    },
    bootstrap_prompts: {
      issue: "Global issue {issue_number} in {repo} on {branch}.",
      pr: "Global pr {pr_number} in {workspace_name}.",
    },
    repos: {
      "kong/kongctl": {
        default_agent: "codex",
        main_worktree: "~/dev/kong/kongctl",
        worktree_base: "~/.local/share/worktrees/kong/kongctl",
        tmux_session: "kongctl",
        additional_paths: [],
        bootstrap_prompts: {
          pr: "Repo pr {pr_number} in {repo} on {branch}.",
        },
        agent_defaults: {
          args: [],
          env: {},
        },
        agent_overrides: {},
      },
    },
    environments: {},
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

describe("buildBootstrapPrompt", () => {
  it("uses the built-in issue prompt when no config override exists", () => {
    const baseConfig = makeConfig();
    const config: PitchConfig = {
      ...baseConfig,
      bootstrap_prompts: {},
      repos: {
        "kong/kongctl": {
          ...baseConfig.repos["kong/kongctl"],
          bootstrap_prompts: {},
        },
      },
    };

    expect(
      buildBootstrapPrompt(config, {
        repo: "kong/kongctl",
        source_kind: "issue",
        source_number: 42,
        workspace_name: "gh-42-fix-bug",
        branch: "gh-42-fix-bug",
      }),
    ).toBe(
      "Read GitHub issue #42 in kong/kongctl using gh, understand the task, and wait for the next instruction. Do not make changes yet.",
    );
  });

  it("uses the top-level prompt when a repo override is not present", () => {
    expect(
      buildBootstrapPrompt(makeConfig(), {
        repo: "kong/kongctl",
        source_kind: "issue",
        source_number: 42,
        workspace_name: "gh-42-fix-bug",
        branch: "gh-42-fix-bug",
      }),
    ).toBe("Global issue 42 in kong/kongctl on gh-42-fix-bug.");
  });

  it("uses the repo override when present", () => {
    expect(
      buildBootstrapPrompt(makeConfig(), {
        repo: "kong/kongctl",
        source_kind: "pr",
        source_number: 123,
        workspace_name: "pr-123-sync-pr",
        branch: "feature/example",
      }),
    ).toBe("Repo pr 123 in kong/kongctl on feature/example.");
  });

  it("uses the built-in ad hoc prompt when no override exists", () => {
    expect(
      buildBootstrapPrompt(makeConfig(), {
        repo: "kong/kongctl",
        source_kind: "adhoc",
        source_number: null,
        workspace_name: "spike-auth",
        branch: "feature/auth",
      }),
    ).toBe(
      "Inspect the current repo state on branch feature/auth in kong/kongctl and wait for the next instruction. Do not make changes yet.",
    );
  });
});
