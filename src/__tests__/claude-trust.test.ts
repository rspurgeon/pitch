import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ensureClaudeTrustedPaths } from "../claude-trust.js";

describe("Claude trust bootstrap", () => {
  it("marks stable repo and worktree roots as trusted in the Claude state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitch-claude-trust-"));
    const configDir = join(root, ".claude-test");

    await ensureClaudeTrustedPaths({
      environment: { kind: "host" },
      workspace_paths: {
        host_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
        agent_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
        guest_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
      },
      repo: {
        main_worktree: join(root, "repo"),
        worktree_base: join(root, "worktrees"),
      },
      claude_config_dir: configDir,
    });

    const state = JSON.parse(
      await readFile(join(configDir, ".claude.json"), "utf8"),
    ) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };

    expect(state.projects[join(root, "repo")]).toEqual({
      hasTrustDialogAccepted: true,
    });
    expect(state.projects[join(root, "worktrees")]).toEqual({
      hasTrustDialogAccepted: true,
    });
    expect(state.projects[join(root, "worktrees", "gh-42-fix-bug")]).toBeUndefined();
  });

  it("preserves existing Claude state while adding trusted paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitch-claude-trust-"));
    const configDir = join(root, ".claude-test");
    await mkdir(configDir, { recursive: true });

    await writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify(
        {
          oauthAccount: { email: "rick@example.com" },
          projects: {
            [join(root, "existing")]: {
              hasTrustDialogAccepted: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await ensureClaudeTrustedPaths({
      environment: { kind: "host" },
      workspace_paths: {
        host_worktree_path: join(root, "worktrees", "gh-99-resume"),
        agent_worktree_path: join(root, "worktrees", "gh-99-resume"),
        guest_worktree_path: join(root, "worktrees", "gh-99-resume"),
      },
      repo: {
        main_worktree: join(root, "repo"),
        worktree_base: join(root, "worktrees"),
      },
      claude_config_dir: configDir,
    });

    const state = JSON.parse(
      await readFile(join(configDir, ".claude.json"), "utf8"),
    ) as {
      oauthAccount?: { email?: string };
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };

    expect(state.oauthAccount).toEqual({ email: "rick@example.com" });
    expect(state.projects[join(root, "existing")]).toEqual({
      hasTrustDialogAccepted: true,
    });
    expect(state.projects[join(root, "worktrees")]).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  it("prunes redundant workspace-specific trust entries when parent roots are trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitch-claude-trust-"));
    const configDir = join(root, ".claude-test");
    await mkdir(configDir, { recursive: true });

    await writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify(
        {
          projects: {
            [join(root, "worktrees", "gh-42-old")]: {
              hasTrustDialogAccepted: true,
            },
            [join(root, "worktrees", "gh-43-keep")]: {
              hasTrustDialogAccepted: true,
              note: "preserve-extra-state",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await ensureClaudeTrustedPaths({
      environment: { kind: "host" },
      workspace_paths: {
        host_worktree_path: join(root, "worktrees", "gh-99-resume"),
        agent_worktree_path: join(root, "worktrees", "gh-99-resume"),
        guest_worktree_path: join(root, "worktrees", "gh-99-resume"),
      },
      repo: {
        main_worktree: join(root, "repo"),
        worktree_base: join(root, "worktrees"),
      },
      claude_config_dir: configDir,
    });

    const state = JSON.parse(
      await readFile(join(configDir, ".claude.json"), "utf8"),
    ) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean; note?: string }>;
    };

    expect(state.projects[join(root, "worktrees")]).toEqual({
      hasTrustDialogAccepted: true,
    });
    expect(state.projects[join(root, "worktrees", "gh-42-old")]).toBeUndefined();
    expect(state.projects[join(root, "worktrees", "gh-43-keep")]).toEqual({
      hasTrustDialogAccepted: true,
      note: "preserve-extra-state",
    });
  });
});
