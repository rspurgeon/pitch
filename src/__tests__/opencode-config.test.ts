import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("merges an existing custom OpenCode config into the generated file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pitch-opencode-config-"));
    const baseConfigPath = join(rootDir, "base.json");

    try {
      await writeFile(
        baseConfigPath,
        `${JSON.stringify(
          {
            theme: "system",
            permission: {
              bash: "ask",
              external_directory: {
                "~/existing/**": "allow",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const filePath = await ensureOpencodeConfig(
        {
          workspace_name: "gh-35-opencode-paths",
          additional_paths: ["~/go"],
          base_config_path: baseConfigPath,
        },
        rootDir,
      );

      expect(JSON.parse(await readFile(filePath!, "utf-8"))).toEqual({
        $schema: "https://opencode.ai/config.json",
        theme: "system",
        permission: {
          bash: "ask",
          external_directory: {
            "~/existing/**": "allow",
            "~/go/**": "allow",
          },
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe workspace names", () => {
    expect(() =>
      opencodeConfigPathForWorkspace("../gh-35-opencode-paths"),
    ).toThrow("Invalid workspace name");
  });

  it("rejects invalid additional paths", () => {
    expect(() => buildOpencodeAdditionalPathsConfig(["   "])).toThrow(
      "paths cannot be empty",
    );
    expect(() => buildOpencodeAdditionalPathsConfig(["relative/path"])).toThrow(
      "Paths must be absolute or start with ~/",
    );
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
