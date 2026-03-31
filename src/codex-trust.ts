import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import type { VmSshExecutionEnvironmentConfig } from "./config.js";
import type {
  ResolvedExecutionEnvironment,
  ResolvedWorkspacePaths,
} from "./execution-environment.js";
import { shellEscape } from "./shell.js";

const execFileAsync = promisify(execFile);

export interface EnsureCodexTrustedPathInput {
  environment: ResolvedExecutionEnvironment;
  workspace_paths: ResolvedWorkspacePaths;
  codex_home?: string;
}

function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function resolveCodexHome(path: string | undefined): string {
  return normalize(resolve(expandHomePath(path ?? "~/.codex")));
}

function buildTrustedWorkspacePath(
  environment: ResolvedExecutionEnvironment,
  workspacePaths: ResolvedWorkspacePaths,
): string {
  return normalize(
    resolve(
      environment.kind === "vm-ssh"
        ? workspacePaths.guest_worktree_path
        : workspacePaths.host_worktree_path,
    ),
  );
}

function projectHeader(path: string): string {
  return `[projects."${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
}

function setProjectTrust(contents: string, trustedPath: string): string {
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/);
  const header = projectHeader(trustedPath);
  const existingIndex = lines.findIndex((line) => line.trim() === header);

  if (existingIndex === -1) {
    const trimmed = contents.trimEnd();
    const prefix = trimmed.length === 0 ? "" : `${trimmed}\n\n`;
    return `${prefix}${header}\ntrust_level = "trusted"\n`;
  }

  let nextSection = lines.length;
  for (let index = existingIndex + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim().startsWith("[")) {
      nextSection = index;
      break;
    }
  }

  const trustIndex = lines
    .slice(existingIndex + 1, nextSection)
    .findIndex((line) => line.trim().startsWith("trust_level"));

  if (trustIndex === -1) {
    lines.splice(existingIndex + 1, 0, 'trust_level = "trusted"');
  } else {
    lines[existingIndex + 1 + trustIndex] = 'trust_level = "trusted"';
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function removeProjectTrust(contents: string, trustedPath: string): string {
  const lines = contents.length === 0 ? [] : contents.split(/\r?\n/);
  const header = projectHeader(trustedPath);
  const existingIndex = lines.findIndex((line) => line.trim() === header);

  if (existingIndex === -1) {
    return contents;
  }

  let nextSection = lines.length;
  for (let index = existingIndex + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim().startsWith("[")) {
      nextSection = index;
      break;
    }
  }

  const sectionLines = lines.slice(existingIndex + 1, nextSection)
    .filter((line) => line.trim().length > 0);
  const trustOnly = sectionLines.length === 1 &&
    sectionLines[0]!.trim() === 'trust_level = "trusted"';

  if (!trustOnly) {
    return contents;
  }

  let start = existingIndex;
  while (start > 0 && lines[start - 1]!.trim().length === 0) {
    start -= 1;
  }

  lines.splice(start, nextSection - start);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

async function updateCodexConfigFile(
  codexHome: string,
  trustedPath: string,
  operation: "add" | "remove",
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");

  let contents = "";
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const updated = operation === "add"
    ? setProjectTrust(contents, trustedPath)
    : removeProjectTrust(contents, trustedPath);
  await writeFile(configPath, updated, "utf8");
}

function buildVmTrustCommand(
  codexHome: string,
  trustedPath: string,
  operation: "add" | "remove",
): string {
  const pythonScript = [
    "import os, sys",
    "codex_home = os.path.abspath(os.path.expanduser(sys.argv[1]))",
    "trusted_path = os.path.abspath(os.path.expanduser(sys.argv[2]))",
    "operation = sys.argv[3]",
    "os.makedirs(codex_home, exist_ok=True)",
    "config_path = os.path.join(codex_home, 'config.toml')",
    "contents = ''",
    "if os.path.exists(config_path):",
    "    with open(config_path, 'r', encoding='utf-8') as fh:",
    "        contents = fh.read()",
    "header = f'[projects.\"{trusted_path.replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}\"]'",
    "lines = [] if len(contents) == 0 else contents.splitlines()",
    "existing_index = next((i for i, line in enumerate(lines) if line.strip() == header), -1)",
    "if operation == 'add':",
    "    if existing_index == -1:",
    "        trimmed = contents.rstrip()",
    "        contents = (trimmed + '\\n\\n' if len(trimmed) else '') + header + '\\ntrust_level = \"trusted\"\\n'",
    "    else:",
    "        next_section = len(lines)",
    "        for idx in range(existing_index + 1, len(lines)):",
    "            if lines[idx].strip().startswith('['):",
    "                next_section = idx",
    "                break",
    "        trust_index = next((i for i, line in enumerate(lines[existing_index + 1:next_section]) if line.strip().startswith('trust_level')), -1)",
    "        if trust_index == -1:",
    "            lines.insert(existing_index + 1, 'trust_level = \"trusted\"')",
    "        else:",
    "            lines[existing_index + 1 + trust_index] = 'trust_level = \"trusted\"'",
    "        contents = '\\n'.join(lines).rstrip() + '\\n'",
    "else:",
    "    if existing_index != -1:",
    "        next_section = len(lines)",
    "        for idx in range(existing_index + 1, len(lines)):",
    "            if lines[idx].strip().startswith('['):",
    "                next_section = idx",
    "                break",
    "        section_lines = [line for line in lines[existing_index + 1:next_section] if line.strip()]",
    "        trust_only = len(section_lines) == 1 and section_lines[0].strip() == 'trust_level = \"trusted\"'",
    "        if trust_only:",
    "            start = existing_index",
    "            while start > 0 and len(lines[start - 1].strip()) == 0:",
    "                start -= 1",
    "            del lines[start:next_section]",
    "            contents = '\\n'.join(lines).rstrip() + ('\\n' if lines else '')",
    "with open(config_path, 'w', encoding='utf-8') as fh:",
    "    fh.write(contents)",
  ].join("\n");
  const encodedScript = Buffer.from(pythonScript, "utf8").toString("base64");

  return [
    "python3",
    "-c",
    [
      "import base64,sys",
      `exec(base64.b64decode(${JSON.stringify(encodedScript)}).decode())`,
    ].join(";"),
    codexHome,
    trustedPath,
    operation,
  ].map((part) => shellEscape(part)).join(" ");
}

async function updateVmCodexConfigFile(
  vmConfig: VmSshExecutionEnvironmentConfig,
  codexHome: string,
  trustedPath: string,
  operation: "add" | "remove",
): Promise<void> {
  const sshTarget = vmConfig.ssh_user === undefined
    ? vmConfig.ssh_host
    : `${vmConfig.ssh_user}@${vmConfig.ssh_host}`;

  const command = ["ssh", "-o", "BatchMode=yes"];
  if (vmConfig.ssh_identity_file !== undefined) {
    command.push("-i", vmConfig.ssh_identity_file);
  }
  if (vmConfig.ssh_port !== undefined) {
    command.push("-p", String(vmConfig.ssh_port));
  }

  command.push(
    ...vmConfig.ssh_options,
    sshTarget,
    `bash -lc ${shellEscape(buildVmTrustCommand(codexHome, trustedPath, operation))}`,
  );

  await execFileAsync(command[0]!, command.slice(1));
}

export async function ensureCodexTrustedPath(
  input: EnsureCodexTrustedPathInput,
): Promise<void> {
  const codexHome = resolveCodexHome(input.codex_home);
  const trustedPath = buildTrustedWorkspacePath(
    input.environment,
    input.workspace_paths,
  );

  if (input.environment.kind !== "vm-ssh") {
    await updateCodexConfigFile(codexHome, trustedPath, "add");
    return;
  }

  const vmConfig = input.environment.config as VmSshExecutionEnvironmentConfig | undefined;
  if (vmConfig === undefined) {
    throw new Error("Missing vm-ssh execution environment config");
  }

  await updateVmCodexConfigFile(vmConfig, codexHome, trustedPath, "add");
}

export async function removeCodexTrustedPath(
  input: EnsureCodexTrustedPathInput,
): Promise<void> {
  const codexHome = resolveCodexHome(input.codex_home);
  const trustedPath = buildTrustedWorkspacePath(
    input.environment,
    input.workspace_paths,
  );

  if (input.environment.kind !== "vm-ssh") {
    await updateCodexConfigFile(codexHome, trustedPath, "remove");
    return;
  }

  const vmConfig = input.environment.config as VmSshExecutionEnvironmentConfig | undefined;
  if (vmConfig === undefined) {
    throw new Error("Missing vm-ssh execution environment config");
  }

  await updateVmCodexConfigFile(vmConfig, codexHome, trustedPath, "remove");
}
