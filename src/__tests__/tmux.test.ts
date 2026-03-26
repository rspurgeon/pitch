import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTmuxLayout,
  createTmuxWindow,
  ensureTmuxSession,
  getTmuxPaneInfo,
  getTmuxWindowPaneInfo,
  getTmuxWindowPane,
  isTmuxAvailable,
  killTmuxWindow,
  sendKeysToPane,
  tmuxSessionExists,
  tmuxWindowExists,
  TmuxError,
  type TmuxClientOptions,
} from "../tmux.js";

const execFileAsync = promisify(execFile);

function canRunTmuxIntegrationTests(): boolean {
  if (!isTmuxAvailable()) {
    return false;
  }

  const probeRoot = mkdtempSync(join(tmpdir(), "pitch-tmux-probe-"));
  const probeSocketPath = join(probeRoot, "probe.sock");
  const probeWorktreePath = join(probeRoot, "worktree");

  try {
    mkdirSync(probeWorktreePath, { recursive: true });

    const startResult = spawnSync(
      "tmux",
      [
        "-f",
        "/dev/null",
        "-S",
        probeSocketPath,
        "new-session",
        "-d",
        "-s",
        "pitch-probe",
        "-c",
        probeWorktreePath,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          TMUX: "",
        },
      },
    );

    if (startResult.status !== 0) {
      return false;
    }

    spawnSync(
      "tmux",
      ["-f", "/dev/null", "-S", probeSocketPath, "kill-server"],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          TMUX: "",
        },
      },
    );
    return true;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const tmuxIntegrationAvailable = canRunTmuxIntegrationTests();

async function runTmux(
  args: string[],
  options: TmuxClientOptions,
): Promise<string> {
  const tmuxArgs =
    options.config_file !== undefined
      ? options.socket_path !== undefined
        ? ["-f", options.config_file, "-S", options.socket_path, ...args]
        : options.socket_name !== undefined
          ? ["-f", options.config_file, "-L", options.socket_name, ...args]
          : ["-f", options.config_file, ...args]
      : options.socket_path !== undefined
        ? ["-S", options.socket_path, ...args]
        : options.socket_name !== undefined
          ? ["-L", options.socket_name, ...args]
          : args;
  const { stdout } = await execFileAsync("tmux", tmuxArgs, {
    env:
      options.socket_name !== undefined || options.socket_path !== undefined
        ? { ...process.env, TMUX: "" }
        : process.env,
  });
  return stdout.trim();
}

async function paneCurrentPath(
  paneId: string,
  options: TmuxClientOptions,
): Promise<string> {
  return runTmux(
    ["display-message", "-p", "-t", paneId, "#{pane_current_path}"],
    options,
  );
}

async function capturePane(
  paneId: string,
  options: TmuxClientOptions,
): Promise<string> {
  return runTmux(["capture-pane", "-p", "-t", paneId], options);
}

async function activePaneId(
  windowTarget: string,
  options: TmuxClientOptions,
): Promise<string> {
  return runTmux(
    ["display-message", "-p", "-t", windowTarget, "#{pane_id}"],
    options,
  );
}

async function ensureIsolatedTestSession(
  sessionName: string,
  worktreePath: string,
  options: TmuxClientOptions,
): Promise<void> {
  await ensureTmuxSession(
    {
      session_name: sessionName,
      start_directory: worktreePath,
    },
    options,
  );
  await runTmux(["set-option", "-g", "default-shell", "/bin/sh"], options);
  await runTmux(["set-option", "-g", "default-command", "exec /bin/sh"], options);
  await runTmux(["set-option", "-g", "status", "off"], options);
}

async function waitForPaneText(
  paneId: string,
  text: string,
  options: TmuxClientOptions,
): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const content = await capturePane(paneId, options);
    if (content.includes(text)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for pane ${paneId} to contain: ${text}`);
}

const tmuxDescribe = tmuxIntegrationAvailable ? describe : describe.skip;

tmuxDescribe("tmux management", () => {
  let tempRoot: string;
  let worktreePath: string;
  let options: TmuxClientOptions;
  let sessionName: string;
  let windowName: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pitch-tmux-"));
    worktreePath = join(tempRoot, "worktree");
    await mkdir(worktreePath, { recursive: true });

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    options = {
      socket_path: join(tempRoot, `tmux-${suffix}.sock`),
      config_file: "/dev/null",
    };
    sessionName = `pitch-session-${suffix}`;
    windowName = `gh-123-${suffix}`;
  });

  afterEach(async () => {
    try {
      await runTmux(["kill-session", "-t", sessionName], options);
    } catch {
      // ignore missing server
    }

    await rm(tempRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    if (!tmuxIntegrationAvailable) {
      console.error(
        "tmux integration tests skipped because tmux is not usable in this environment.",
      );
    }
  });

  it("checks for tmux session existence and creates a session if needed", async () => {
    await expect(tmuxSessionExists(sessionName, options)).resolves.toBe(false);

    await expect(
      ensureTmuxSession(
        {
          session_name: sessionName,
          start_directory: worktreePath,
        },
        options,
      ),
    ).resolves.toEqual({
      session_name: sessionName,
      created: true,
    });

    await expect(tmuxSessionExists(sessionName, options)).resolves.toBe(true);
    await expect(
      ensureTmuxSession(
        {
          session_name: sessionName,
          start_directory: worktreePath,
        },
        options,
      ),
    ).resolves.toEqual({
      session_name: sessionName,
      created: false,
    });
  });

  it("creates a named tmux window and detects duplicates", async () => {
    await ensureIsolatedTestSession(sessionName, worktreePath, options);

    const created = await createTmuxWindow(
      {
        session_name: sessionName,
        window_name: windowName,
        start_directory: worktreePath,
      },
      options,
    );

    expect(created.window_target).toBe(`${sessionName}:${windowName}`);
    await expect(tmuxWindowExists(sessionName, windowName, options)).resolves.toBe(
      true,
    );
    await expect(
      createTmuxWindow(
        {
          session_name: sessionName,
          window_name: windowName,
          start_directory: worktreePath,
        },
        options,
      ),
    ).rejects.toMatchObject({
      name: "TmuxError",
      code: "WINDOW_EXISTS",
    });
  });

  it("creates a new window when the tmux session uses base-index 1", async () => {
    await ensureIsolatedTestSession(sessionName, worktreePath, options);
    await runTmux(["set-option", "-g", "base-index", "1"], options);
    await runTmux(["move-window", "-r", "-s", `${sessionName}:0`], options);

    const before = await runTmux(
      ["list-windows", "-t", sessionName, "-F", "#{window_index}:#{window_name}"],
      options,
    );
    expect(before).toContain("1:");

    const created = await createTmuxWindow(
      {
        session_name: sessionName,
        window_name: windowName,
        start_directory: worktreePath,
      },
      options,
    );

    expect(created.window_target).toBe(`${sessionName}:${windowName}`);
    const after = await runTmux(
      ["list-windows", "-t", sessionName, "-F", "#{window_index}:#{window_name}"],
      options,
    );
    expect(after).toContain(`2:${windowName}`);
  });

  it("kills an existing tmux window", async () => {
    await ensureIsolatedTestSession(sessionName, worktreePath, options);
    await createTmuxWindow(
      {
        session_name: sessionName,
        window_name: windowName,
        start_directory: worktreePath,
      },
      options,
    );

    await expect(
      killTmuxWindow(
        {
          session_name: sessionName,
          window_name: windowName,
        },
        options,
      ),
    ).resolves.toBe(true);
    await expect(tmuxWindowExists(sessionName, windowName, options)).resolves.toBe(
      false,
    );
    await expect(
      killTmuxWindow(
        {
          session_name: sessionName,
          window_name: windowName,
        },
        options,
      ),
    ).resolves.toBe(false);
  });

  it("creates the three-pane layout and cds each pane to the worktree path", async () => {
    await ensureIsolatedTestSession(sessionName, worktreePath, options);
    const otherStartDirectory = join(tempRoot, "other-start-dir");
    await mkdir(otherStartDirectory, { recursive: true });
    await createTmuxWindow(
      {
        session_name: sessionName,
        window_name: windowName,
        start_directory: otherStartDirectory,
      },
      options,
    );

    const layout = await createTmuxLayout(
      {
        session_name: sessionName,
        window_name: windowName,
        worktree_path: worktreePath,
      },
      options,
    );

    const panes = layout.panes;
    expect(Object.values(panes)).toHaveLength(3);

    const paneGeometry = await Promise.all(
      Object.values(panes).map(async (paneId) => {
        const geometry = await runTmux(
          [
            "display-message",
            "-p",
            "-t",
            paneId,
            "#{pane_left},#{pane_top},#{pane_width},#{pane_height}",
          ],
          options,
        );
        return geometry.split(",").map((value) => Number.parseInt(value, 10));
      }),
    );

    const [agentLeft, agentTop, , agentHeight] = paneGeometry[0];
    const [topRightLeft, topRightTop, topRightWidth, topRightHeight] =
      paneGeometry[1];
    const [bottomRightLeft, bottomRightTop, bottomRightWidth, bottomRightHeight] =
      paneGeometry[2];

    expect(agentLeft).toBe(0);
    expect(agentTop).toBe(0);
    expect(topRightLeft).toBeGreaterThan(0);
    expect(bottomRightLeft).toBe(topRightLeft);
    expect(bottomRightWidth).toBe(topRightWidth);
    expect(topRightTop).toBe(0);
    expect(bottomRightTop).toBeGreaterThan(0);
    expect(agentHeight).toBeGreaterThan(topRightHeight);
    expect(agentHeight).toBeGreaterThan(bottomRightHeight);

    await expect(
      Promise.all(
        Object.values(panes).map((paneId) => paneCurrentPath(paneId, options)),
      ),
    ).resolves.toEqual([worktreePath, worktreePath, worktreePath]);
    await expect(activePaneId(layout.window_target, options)).resolves.toBe(
      panes.agent_pane_id,
    );
    await expect(
      getTmuxWindowPane(
        {
          session_name: sessionName,
          window_name: windowName,
          pane_index: 0,
        },
        options,
      ),
    ).resolves.toBe(panes.agent_pane_id);
    await expect(
      getTmuxWindowPane(
        {
          session_name: sessionName,
          window_name: windowName,
          pane_index: 1,
        },
        options,
      ),
    ).resolves.toBe(panes.top_right_pane_id);
    await expect(
      getTmuxWindowPane(
        {
          session_name: sessionName,
          window_name: windowName,
          pane_index: 2,
        },
        options,
      ),
    ).resolves.toBe(panes.bottom_right_pane_id);
    await expect(
      getTmuxWindowPaneInfo(
        {
          session_name: sessionName,
          window_name: windowName,
          pane_index: 0,
        },
        options,
      ),
    ).resolves.toEqual({
      pane_id: panes.agent_pane_id,
      current_command: "sh",
      current_path: worktreePath,
    });
  });

  it("sends a command to a specific pane", async () => {
    await ensureIsolatedTestSession(sessionName, worktreePath, options);
    const window = await createTmuxWindow(
      {
        session_name: sessionName,
        window_name: windowName,
        start_directory: worktreePath,
      },
      options,
    );

    await sendKeysToPane(
      {
        pane_id: window.pane_id,
        command: "printf 'pitch-pane-test\\n'",
      },
      options,
    );
    await waitForPaneText(window.pane_id, "pitch-pane-test", options);
  });

  it("sends literal text to a specific pane and presses Enter", async () => {
    await ensureIsolatedTestSession(sessionName, worktreePath, options);
    const window = await createTmuxWindow(
      {
        session_name: sessionName,
        window_name: windowName,
        start_directory: worktreePath,
      },
      options,
    );

    await sendKeysToPane(
      {
        pane_id: window.pane_id,
        command: "printf 'literal tmux text\\n'",
        literal: true,
      },
      options,
    );
    await waitForPaneText(window.pane_id, "literal tmux text", options);
    const content = await capturePane(window.pane_id, options);
    expect(content).not.toContain("Enter");
  });

  it("reads pane info by pane id", async () => {
    await ensureIsolatedTestSession(sessionName, worktreePath, options);
    const window = await createTmuxWindow(
      {
        session_name: sessionName,
        window_name: windowName,
        start_directory: worktreePath,
      },
      options,
    );

    await expect(
      getTmuxPaneInfo(
        {
          pane_id: window.pane_id,
        },
        options,
      ),
    ).resolves.toEqual({
      pane_id: window.pane_id,
      current_command: "sh",
      current_path: worktreePath,
    });
  });

  it("returns typed errors for invalid names", async () => {
    await expect(
      ensureTmuxSession(
        {
          session_name: "bad:name",
          start_directory: worktreePath,
        },
        options,
      ),
    ).rejects.toBeInstanceOf(TmuxError);
    await expect(
      createTmuxWindow(
        {
          session_name: sessionName,
          window_name: "bad:name",
          start_directory: worktreePath,
        },
        options,
      ),
    ).rejects.toBeInstanceOf(TmuxError);
  });
});
