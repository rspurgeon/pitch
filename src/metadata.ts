import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FALLBACK_VERSION = "0.1.0";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(moduleDir, "..");
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");

interface PackageJson {
  version?: unknown;
}

export interface RuntimeMetadata {
  name: "pitch";
  version: string;
  git_commit: string | null;
  git_commit_short: string | null;
  git_branch: string | null;
  git_dirty: boolean | null;
  launch_mode: "source" | "build" | "unknown";
  entrypoint: string | null;
  repo_root: string;
}

interface MetadataDependencies {
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  execFile: (
    file: string,
    args: string[],
    options: { cwd: string },
  ) => Promise<{ stdout: string; stderr: string }>;
  argv: string[];
}

const defaultDependencies: MetadataDependencies = {
  readFile,
  execFile: execFileAsync,
  argv: process.argv,
};

function detectLaunchMode(entrypoint: string | null): RuntimeMetadata["launch_mode"] {
  if (entrypoint === null) {
    return "unknown";
  }

  if (entrypoint.endsWith("/src/index.ts")) {
    return "source";
  }

  if (entrypoint.endsWith("/dist/index.js")) {
    return "build";
  }

  return "unknown";
}

async function readVersion(dependencies: MetadataDependencies): Promise<string> {
  try {
    const raw = await dependencies.readFile(PACKAGE_JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PackageJson;
    return typeof parsed.version === "string" ? parsed.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

async function runGit(
  dependencies: MetadataDependencies,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await dependencies.execFile("git", args, {
      cwd: REPO_ROOT,
    });
    const value = stdout.trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

async function readGitDirty(
  dependencies: MetadataDependencies,
): Promise<boolean | null> {
  try {
    await dependencies.execFile(
      "git",
      ["diff", "--quiet", "--ignore-submodules", "HEAD", "--"],
      { cwd: REPO_ROOT },
    );
    return false;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === 1
    ) {
      return true;
    }

    return null;
  }
}

export async function getRuntimeMetadata(
  dependencies: MetadataDependencies = defaultDependencies,
): Promise<RuntimeMetadata> {
  const entrypoint = dependencies.argv[1] ?? null;
  const [version, gitCommit, gitBranch, gitDirty] = await Promise.all([
    readVersion(dependencies),
    runGit(dependencies, ["rev-parse", "HEAD"]),
    runGit(dependencies, ["rev-parse", "--abbrev-ref", "HEAD"]),
    readGitDirty(dependencies),
  ]);

  return {
    name: "pitch",
    version,
    git_commit: gitCommit,
    git_commit_short: gitCommit?.slice(0, 7) ?? null,
    git_branch: gitBranch,
    git_dirty: gitDirty,
    launch_mode: detectLaunchMode(entrypoint),
    entrypoint,
    repo_root: REPO_ROOT,
  };
}
