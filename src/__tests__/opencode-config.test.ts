import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOpencodeAdditionalPathsConfig,
  ensureOpencodeConfig,
  opencodeConfigPathForWorkspace,
} from "../opencode-config.js";

describe("opencode config", () => {
  it("builds external directory permissions for all additional paths", () => {
    expect(
      buildOpencodeAdditionalPathsConfig([
        "~/go",
        "/home/rspurgeon/.config/kongctl/",
      ]),
    ).toEqual({
      $schema: "https://opencode.ai/config.json",
      permission: {
        external_directory: {
          "~/go/**": "allow",
          "/home/rspurgeon/.config/kongctl/**": "allow",
        },
      },
    });
  });

  it("writes generated config outside the repo", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pitch-opencode-config-"));

    try {
      const filePath = await ensureOpencodeConfig(
        {
          workspace_name: "gh-35-opencode-paths",
          additional_paths: ["~/go", "~/.config/kongctl"],
        },
        rootDir,
      );

      expect(filePath).toBe(
        opencodeConfigPathForWorkspace("gh-35-opencode-paths", rootDir),
      );
      expect(JSON.parse(await readFile(filePath!, "utf-8"))).toEqual({
        $schema: "https://opencode.ai/config.json",
        permission: {
          external_directory: {
            "~/go/**": "allow",
            "~/.config/kongctl/**": "allow",
          },
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("skips file generation when no additional paths are configured", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pitch-opencode-config-"));

    try {
      await expect(
        ensureOpencodeConfig(
          {
            workspace_name: "gh-35-opencode-paths",
            additional_paths: [],
          },
          rootDir,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
