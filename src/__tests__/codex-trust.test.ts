import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ensureCodexTrustedPath,
  removeCodexTrustedPath,
} from "../codex-trust.js";

describe("Codex trust bootstrap", () => {
  it("adds a trusted workspace entry to config.toml", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitch-codex-trust-"));
    const codexHome = join(root, ".codex-test");

    await ensureCodexTrustedPath({
      environment: { kind: "host" },
      workspace_paths: {
        host_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
        agent_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
        guest_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
      },
      codex_home: codexHome,
    });

    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain(
      `[projects."${join(root, "worktrees", "gh-42-fix-bug")}"]`,
    );
    expect(config).toContain('trust_level = "trusted"');
  });

  it("removes trust-only workspace entries while preserving other config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitch-codex-trust-"));
    const codexHome = join(root, ".codex-test");
    await mkdir(codexHome, { recursive: true });

    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        "",
        `[projects."${join(root, "worktrees", "gh-42-fix-bug")}"]`,
        'trust_level = "trusted"',
        "",
        `[projects."${join(root, "repo")}"]`,
        'trust_level = "trusted"',
        'note = "keep"',
        "",
      ].join("\n"),
      "utf8",
    );

    await removeCodexTrustedPath({
      environment: { kind: "host" },
      workspace_paths: {
        host_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
        agent_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
        guest_worktree_path: join(root, "worktrees", "gh-42-fix-bug"),
      },
      codex_home: codexHome,
    });

    const config = await readFile(join(codexHome, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5.4"');
    expect(config).not.toContain(
      `[projects."${join(root, "worktrees", "gh-42-fix-bug")}"]`,
    );
    expect(config).toContain(`[projects."${join(root, "repo")}"]`);
    expect(config).toContain('note = "keep"');
  });
});
