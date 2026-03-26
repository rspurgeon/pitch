import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EnsureOpencodeConfigInput {
  workspace_name: string;
  additional_paths: string[];
  base_config_path?: string;
}

interface OpencodeConfigFile {
  $schema: string;
  permission: {
    external_directory: Record<string, "allow">;
  };
  [key: string]: unknown;
}

export const DEFAULT_OPENCODE_CONFIG_ROOT = join(
  homedir(),
  ".pitch",
  "opencode",
);

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function isSafeWorkspaceName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function validateWorkspaceName(name: string): string {
  if (!isSafeWorkspaceName(name)) {
    throw new Error(`Invalid workspace name: ${name}`);
  }

  return name;
}

function sanitizeAdditionalPaths(paths: string[]): string[] {
  return paths.map((rawPath) => {
    const path = rawPath.trim();
    if (path.length === 0) {
      throw new Error("Invalid OpenCode additional_path: paths cannot be empty");
    }

    if (path.startsWith("~/") || path === "~" || path.startsWith("/")) {
      return path;
    }

    throw new Error(
      `Invalid OpenCode additional_path: ${path}. Paths must be absolute or start with ~/`,
    );
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeObjects(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeObjects(existing, value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

async function readBaseConfig(
  baseConfigPath: string | undefined,
): Promise<Record<string, unknown>> {
  if (baseConfigPath === undefined) {
    return {};
  }

  const expandedPath = expandHomePath(baseConfigPath);
  const rawContent = await readFile(expandedPath, "utf-8");
  const parsed: unknown = JSON.parse(rawContent);
  if (!isPlainObject(parsed)) {
    throw new Error(
      `OpenCode base config at ${expandedPath} must contain a JSON object`,
    );
  }

  return parsed;
}

function normalizeExternalDirectoryPattern(path: string): string {
  if (path.endsWith("/**")) {
    return path;
  }

  if (path.endsWith("/")) {
    return `${path}**`;
  }

  return `${path}/**`;
}

export function buildOpencodeAdditionalPathsConfig(
  additionalPaths: string[],
): OpencodeConfigFile {
  const sanitizedPaths = sanitizeAdditionalPaths(additionalPaths);

  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      external_directory: Object.fromEntries(
        sanitizedPaths.map((path) => [
          normalizeExternalDirectoryPattern(path),
          "allow",
        ]),
      ),
    },
  };
}

export function opencodeConfigPathForWorkspace(
  workspaceName: string,
  rootDir: string = DEFAULT_OPENCODE_CONFIG_ROOT,
): string {
  return join(
    expandHomePath(rootDir),
    `${validateWorkspaceName(workspaceName)}.json`,
  );
}

export async function ensureOpencodeConfig(
  input: EnsureOpencodeConfigInput,
  rootDir: string = DEFAULT_OPENCODE_CONFIG_ROOT,
): Promise<string | undefined> {
  const additionalPaths = sanitizeAdditionalPaths(input.additional_paths);
  if (additionalPaths.length === 0) {
    return undefined;
  }

  const filePath = opencodeConfigPathForWorkspace(
    input.workspace_name,
    rootDir,
  );
  const generatedConfig = buildOpencodeAdditionalPathsConfig(additionalPaths);
  const baseConfig = await readBaseConfig(input.base_config_path);
  const config = mergeObjects(baseConfig, generatedConfig);

  await mkdir(expandHomePath(rootDir), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  return filePath;
}
