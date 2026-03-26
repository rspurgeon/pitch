import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EnsureOpencodeConfigInput {
  workspace_name: string;
  additional_paths: string[];
}

interface OpencodeConfigFile {
  $schema: string;
  permission: {
    external_directory: Record<string, "allow">;
  };
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
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      external_directory: Object.fromEntries(
        additionalPaths.map((path) => [
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
  return join(expandHomePath(rootDir), `${workspaceName}.json`);
}

export async function ensureOpencodeConfig(
  input: EnsureOpencodeConfigInput,
  rootDir: string = DEFAULT_OPENCODE_CONFIG_ROOT,
): Promise<string | undefined> {
  if (input.additional_paths.length === 0) {
    return undefined;
  }

  const filePath = opencodeConfigPathForWorkspace(
    input.workspace_name,
    rootDir,
  );
  const config = buildOpencodeAdditionalPathsConfig(input.additional_paths);

  await mkdir(expandHomePath(rootDir), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  return filePath;
}
