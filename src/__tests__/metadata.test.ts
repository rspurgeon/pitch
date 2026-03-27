import { describe, expect, it, vi } from "vitest";
import { getRuntimeMetadata, REPO_ROOT } from "../metadata.js";

describe("runtime metadata", () => {
  it("reports package version git metadata and launch mode", async () => {
    const readFileMock = vi.fn(async () => JSON.stringify({ version: "1.2.3" }));
    const execFileMock = vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe("git");

      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: "abcdef1234567890\n", stderr: "" };
      }

      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "gh-35-oc-addl-paths\n", stderr: "" };
      }

      if (args[0] === "diff") {
        return { stdout: "", stderr: "" };
      }

      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const metadata = await getRuntimeMetadata({
      readFile: readFileMock,
      execFile: execFileMock,
      argv: ["node", "/tmp/project/src/index.ts"],
    });

    expect(metadata).toEqual({
      name: "pitch",
      version: "1.2.3",
      git_commit: "abcdef1234567890",
      git_commit_short: "abcdef1",
      git_branch: "gh-35-oc-addl-paths",
      git_dirty: false,
      launch_mode: "source",
      entrypoint: "/tmp/project/src/index.ts",
      repo_root: REPO_ROOT,
    });
  });

  it("falls back cleanly when package or git metadata is unavailable", async () => {
    const metadata = await getRuntimeMetadata({
      readFile: vi.fn(async () => {
        throw new Error("missing package");
      }),
      execFile: vi.fn(async (_file: string, args: string[]) => {
        if (args[0] === "diff") {
          const error = new Error("dirty") as Error & { code?: number };
          error.code = 1;
          throw error;
        }

        throw new Error("missing git");
      }),
      argv: ["node", "/tmp/project/dist/index.js"],
    });

    expect(metadata.version).toBe("0.1.0");
    expect(metadata.git_commit).toBeNull();
    expect(metadata.git_commit_short).toBeNull();
    expect(metadata.git_branch).toBeNull();
    expect(metadata.git_dirty).toBe(true);
    expect(metadata.launch_mode).toBe("build");
  });
});
