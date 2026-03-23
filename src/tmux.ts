import { execFile, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { shellEscape } from "./shell.js";

const execFileAsync = promisify(execFile);

export interface TmuxClientOptions {
  socket_name?: string;
  socket_path?: string;
  config_file?: string;
}

export interface EnsureTmuxSessionParams {
  session_name: string;
  start_directory: string;
}

export interface CreateTmuxWindowParams {
  session_name: string;
  window_name: string;
  start_directory: string;
}

export interface KillTmuxWindowParams {
  session_name: string;
  window_name: string;
}

export interface CreateTmuxLayoutParams {
  session_name: string;
  window_name: string;
  worktree_path: string;
}

export interface SendKeysToPaneParams {
  pane_id: string;
  command: string;
  enter?: boolean;
}

export interface GetTmuxWindowPaneParams {
  session_name: string;
  window_name: string;
  pane_index?: number;
}

export interface TmuxSessionResult {
  session_name: string;
  created: boolean;
}

export interface TmuxWindowResult {
  session_name: string;
  window_name: string;
  window_target: string;
  pane_id: string;
}

export interface TmuxPaneLayout {
  agent_pane_id: string;
  top_right_pane_id: string;
  bottom_right_pane_id: string;
}

export interface TmuxLayoutResult {
  session_name: string;
  window_name: string;
  window_target: string;
  panes: TmuxPaneLayout;
}

type TmuxErrorCode =
  | "WINDOW_EXISTS"
  | "INVALID_SESSION_NAME"
  | "INVALID_WINDOW_NAME"
  | "COMMAND_FAILED";

export class TmuxError extends Error {
  code: TmuxErrorCode;

  constructor(code: TmuxErrorCode, message: string) {
    super(message);
    this.name = "TmuxError";
    this.code = code;
  }
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

function formatTmuxError(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "stderr" in err &&
    typeof err.stderr === "string" &&
    err.stderr.length > 0
  ) {
    return err.stderr.trim();
  }

  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    return err.message;
  }

  return String(err);
}

function buildTmuxArgs(
  args: string[],
  options: TmuxClientOptions = {},
): string[] {
  if (options.config_file !== undefined) {
    if (options.socket_path !== undefined) {
      return ["-f", options.config_file, "-S", options.socket_path, ...args];
    }

    if (options.socket_name !== undefined) {
      return ["-f", options.config_file, "-L", options.socket_name, ...args];
    }

    return ["-f", options.config_file, ...args];
  }

  if (options.socket_path !== undefined) {
    return ["-S", options.socket_path, ...args];
  }

  if (options.socket_name === undefined) {
    return args;
  }

  return ["-L", options.socket_name, ...args];
}

function tmuxEnv(options: TmuxClientOptions = {}): NodeJS.ProcessEnv {
  if (options.socket_name !== undefined || options.socket_path !== undefined) {
    return {
      ...process.env,
      TMUX: "",
    };
  }

  return process.env;
}

async function runTmux(
  args: string[],
  options: TmuxClientOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("tmux", buildTmuxArgs(args, options), {
      env: tmuxEnv(options),
    });
  } catch (err: unknown) {
    throw new TmuxError(
      "COMMAND_FAILED",
      `tmux command failed: tmux ${buildTmuxArgs(args, options).join(" ")}\n${formatTmuxError(err)}`,
    );
  }
}

function validateSessionName(sessionName: string): string {
  if (sessionName.length === 0 || sessionName.includes(":")) {
    throw new TmuxError(
      "INVALID_SESSION_NAME",
      `Invalid tmux session name: ${sessionName}`,
    );
  }

  return sessionName;
}

function validateWindowName(windowName: string): string {
  if (windowName.length === 0 || windowName.includes(":")) {
    throw new TmuxError(
      "INVALID_WINDOW_NAME",
      `Invalid tmux window name: ${windowName}`,
    );
  }

  return windowName;
}

function windowTarget(sessionName: string, windowName: string): string {
  return `${validateSessionName(sessionName)}:${validateWindowName(windowName)}`;
}

async function getPaneIds(
  target: string,
  options: TmuxClientOptions = {},
): Promise<string[]> {
  const { stdout } = await runTmux(
    ["list-panes", "-t", target, "-F", "#{pane_id}"],
    options,
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function isTmuxAvailable(): boolean {
  return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

export async function tmuxSessionExists(
  sessionName: string,
  options: TmuxClientOptions = {},
): Promise<boolean> {
  validateSessionName(sessionName);

  try {
    await execFileAsync(
      "tmux",
      buildTmuxArgs(["has-session", "-t", sessionName], options),
      {
        env: tmuxEnv(options),
      },
    );
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === 1
    ) {
      return false;
    }

    throw new TmuxError(
      "COMMAND_FAILED",
      `Failed to check tmux session ${sessionName}\n${formatTmuxError(err)}`,
    );
  }
}

export async function ensureTmuxSession(
  params: EnsureTmuxSessionParams,
  options: TmuxClientOptions = {},
): Promise<TmuxSessionResult> {
  const sessionName = validateSessionName(params.session_name);
  const startDirectory = expandHomePath(params.start_directory);

  if (await tmuxSessionExists(sessionName, options)) {
    return {
      session_name: sessionName,
      created: false,
    };
  }

  await runTmux(
    ["new-session", "-d", "-s", sessionName, "-c", startDirectory],
    options,
  );

  return {
    session_name: sessionName,
    created: true,
  };
}

export async function tmuxWindowExists(
  sessionName: string,
  windowName: string,
  options: TmuxClientOptions = {},
): Promise<boolean> {
  const targetSession = validateSessionName(sessionName);
  const targetWindow = validateWindowName(windowName);

  try {
    const { stdout } = await runTmux(
      ["list-windows", "-t", targetSession, "-F", "#{window_name}"],
      options,
    );

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .includes(targetWindow);
  } catch (err: unknown) {
    if (
      err instanceof TmuxError &&
      err.code === "COMMAND_FAILED" &&
      err.message.includes("can't find session")
    ) {
      return false;
    }

    throw err;
  }
}

export async function createTmuxWindow(
  params: CreateTmuxWindowParams,
  options: TmuxClientOptions = {},
): Promise<TmuxWindowResult> {
  const sessionName = validateSessionName(params.session_name);
  const windowName = validateWindowName(params.window_name);
  const startDirectory = expandHomePath(params.start_directory);

  if (await tmuxWindowExists(sessionName, windowName, options)) {
    throw new TmuxError(
      "WINDOW_EXISTS",
      `tmux window already exists: ${windowTarget(sessionName, windowName)}`,
    );
  }

  const { stdout } = await runTmux(
    [
      "new-window",
      "-d",
      "-t",
      sessionName,
      "-n",
      windowName,
      "-c",
      startDirectory,
      "-P",
      "-F",
      "#{pane_id}",
    ],
    options,
  );

  return {
    session_name: sessionName,
    window_name: windowName,
    window_target: windowTarget(sessionName, windowName),
    pane_id: stdout.trim(),
  };
}

export async function killTmuxWindow(
  params: KillTmuxWindowParams,
  options: TmuxClientOptions = {},
): Promise<boolean> {
  const target = windowTarget(params.session_name, params.window_name);

  try {
    await runTmux(["kill-window", "-t", target], options);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof TmuxError &&
      error.code === "COMMAND_FAILED" &&
      (error.message.includes("can't find window") ||
        error.message.includes("can't find session"))
    ) {
      return false;
    }

    throw error;
  }
}

export async function sendKeysToPane(
  params: SendKeysToPaneParams,
  options: TmuxClientOptions = {},
): Promise<void> {
  const args = ["send-keys", "-t", params.pane_id, params.command];
  if (params.enter !== false) {
    args.push("Enter");
  }

  await runTmux(args, options);
}

export async function getTmuxWindowPane(
  params: GetTmuxWindowPaneParams,
  options: TmuxClientOptions = {},
): Promise<string> {
  const target = windowTarget(params.session_name, params.window_name);
  const paneIndex = params.pane_index ?? 0;
  const paneTarget = `${target}.${paneIndex}`;

  try {
    const { stdout } = await runTmux(
      ["display-message", "-p", "-t", paneTarget, "#{pane_id}"],
      options,
    );

    const paneId = stdout.trim();
    if (paneId.length === 0) {
      throw new TmuxError(
        "COMMAND_FAILED",
        `tmux pane lookup returned no pane id for ${paneTarget}`,
      );
    }

    return paneId;
  } catch (error: unknown) {
    if (
      error instanceof TmuxError &&
      error.code === "COMMAND_FAILED" &&
      error.message.includes("can't find")
    ) {
      throw new TmuxError(
        "COMMAND_FAILED",
        `tmux pane does not exist: ${paneTarget}`,
      );
    }

    throw error;
  }
}

export async function createTmuxLayout(
  params: CreateTmuxLayoutParams,
  options: TmuxClientOptions = {},
): Promise<TmuxLayoutResult> {
  const sessionName = validateSessionName(params.session_name);
  const windowName = validateWindowName(params.window_name);
  const target = windowTarget(sessionName, windowName);
  const worktreePath = expandHomePath(params.worktree_path);

  const initialPanes = await getPaneIds(target, options);
  if (initialPanes.length !== 1) {
    throw new TmuxError(
      "COMMAND_FAILED",
      `Expected tmux window to start with one pane: ${target}`,
    );
  }

  const agentPaneId = initialPanes[0];
  const { stdout: topRightPaneStdout } = await runTmux(
    [
      "split-window",
      "-h",
      "-t",
      agentPaneId,
      "-c",
      worktreePath,
      "-P",
      "-F",
      "#{pane_id}",
    ],
    options,
  );
  const topRightPaneId = topRightPaneStdout.trim();

  const { stdout: bottomRightPaneStdout } = await runTmux(
    [
      "split-window",
      "-v",
      "-t",
      topRightPaneId,
      "-c",
      worktreePath,
      "-P",
      "-F",
      "#{pane_id}",
    ],
    options,
  );
  const bottomRightPaneId = bottomRightPaneStdout.trim();

  const cdCommand = `cd -- ${shellEscape(worktreePath)}`;
  for (const paneId of [agentPaneId, topRightPaneId, bottomRightPaneId]) {
    await sendKeysToPane(
      {
        pane_id: paneId,
        command: cdCommand,
      },
      options,
    );
  }

  await runTmux(["select-pane", "-t", agentPaneId], options);

  return {
    session_name: sessionName,
    window_name: windowName,
    window_target: target,
    panes: {
      agent_pane_id: agentPaneId,
      top_right_pane_id: topRightPaneId,
      bottom_right_pane_id: bottomRightPaneId,
    },
  };
}
