interface CommandHelp {
  summary: string;
  usage: string[];
  options?: string[];
  details?: string[];
}

const options: Record<string, [string, string]> = {
  repo: ["--repo REPO", "GitHub owner/repository."],
  workspace: ["--workspace NAME", "Workspace whose provisioner resources should be cleaned up."],
  issue: ["--issue N", "Create from a GitHub issue."],
  pr: ["--pr N", "Create from a GitHub pull request."],
  name: ["--name NAME", "Workspace name."],
  slug: ["--slug SLUG", "Suffix for an issue or PR workspace name."],
  branch: ["--branch BRANCH", "Branch for an ad hoc workspace."],
  "base-branch": ["--base-branch BRANCH", "Base branch for the new worktree."],
  agent: ["--agent AGENT", "Configured agent to launch."],
  environment: ["--environment ENV", "Configured host or VM execution environment."],
  context: ["--context CONTEXT", "Repository context for configuration and credentials."],
  "session-id": ["--session-id ID", "Agent session ID."],
  "tmux-session": ["--tmux-session SESSION", "Target tmux session."],
  "tmux-window": ["--tmux-window WINDOW", "Tmux window to inspect."],
  "additional-dir": ["--additional-dir PATH", "Additional agent-accessible directory; repeatable (--add-dir alias)."],
  model: ["--model MODEL", "Agent model override."],
  prompt: ["--prompt TEXT", "Append instructions to the bootstrap prompt."],
  "skip-prompt": ["--skip-prompt", "Skip the bootstrap prompt."],
  "reset-session": ["--reset-session", "Start a new agent session instead of resuming."],
  sync: ["--sync", "Fast-forward a PR workspace to its latest upstream head."],
  to: ["--to SESSION", "Destination tmux session (--tmux-session alias)."],
  force: ["--force", "Allow deletion despite local worktree changes."],
  "delete-branch-if-empty": ["--delete-branch-if-empty, -d", "Delete the local branch only if unchanged from base and not pushed."],
  pick: ["--pick", "Choose an agent interactively and focus its pane."],
  status: ["--status active|closed|all", "Filter workspace status."],
  sort: ["--sort FIELD[,FIELD...]", "Sort workspaces by status, name, source, repo, agent, or tmux."],
  "group-by": ["--group-by FIELD", "Group workspaces by a sort field."],
  all: ["--all", "Include completed and archived provisioner records."],
  orphaned: ["--orphaned", "Only unfinished resources without workspace ownership."],
  verify: ["--verify", "Check remote state using the provisioner's service credentials."],
  "dry-run": ["--dry-run", "Preview pruning without changing local files."],
  separator: ["--separator TEXT", "Text appended when agent status is present."],
  watch: ["--watch", "Stream status updates."],
  "exit-on-jump": ["--exit-on-jump", "Exit the browser after focusing a workspace (default)."],
  "keep-open-on-jump": ["--keep-open-on-jump", "Keep the browser open after focusing a workspace."],
  "agent-type": ["--agent-type codex|claude", "Agent reporting the error."],
  message: ["--message TEXT", "Error message to record."],
  cwd: ["--cwd PATH", "Agent working directory."],
  "transcript-path": ["--transcript-path PATH", "Agent transcript path."],
  tty: ["--tty TTY", "Agent terminal identifier."],
  json: ["--json", "Emit JSON."],
  help: ["--help", "Show help for this command."],
};

const resumeOptions = ["name", "agent", "environment", "context", "session-id", "tmux-session", "additional-dir", "reset-session", "sync", "json"];

const commands: Record<string, CommandHelp> = {
  create: {
    summary: "Create a workspace with a worktree, tmux session, and coding agent.",
    usage: ["create (--issue N | --pr N) [options] [PROMPT...]", "create --name NAME [options] [PROMPT...]"],
    options: ["issue", "pr", "name", "repo", "slug", "branch", "base-branch", "agent", "environment", "context", "session-id", "tmux-session", "additional-dir", "model", "prompt", "skip-prompt", "json"],
    details: ["The create verb is optional when --issue, --pr, or --name is supplied.", "Trailing PROMPT text is appended to the bootstrap prompt."],
  },
  agents: { summary: "List live agents and their tmux targets.", usage: ["agents [--pick]"], options: ["pick", "json"] },
  "agents-popup": { summary: "Open a tmux menu for switching between live agents.", usage: ["agents-popup"] },
  jump: { summary: "Focus an agent's tmux pane by session ID or an unambiguous prefix.", usage: ["jump <session-id-or-prefix>"], options: ["json"] },
  "agent-status": { summary: "Show live agent activity and hook status.", usage: ["agent-status"], options: ["json"] },
  "agent-error": { summary: "Record an agent error for status displays.", usage: ["agent-error --agent-type TYPE --session-id ID --message TEXT [options]"], options: ["agent-type", "session-id", "message", "cwd", "transcript-path", "tty", "json"] },
  list: {
    summary: "List workspaces, or supply a provisioner name to list its tracked resources.",
    usage: ["list [options]", "list <provisioner> [options]"],
    options: ["repo", "json"],
    details: ["Workspace listing: --status, --sort, --group-by.", "Provisioner listing: --all, --orphaned, --verify.", "Use pitch list <provisioner> --help for provisioner-specific help."],
  },
  show: { summary: "Show saved workspace details, including its environment-file path.", usage: ["show <name>"], options: ["json"] },
  get: { summary: "Show the same saved workspace details as pitch show.", usage: ["get <name>"], options: ["name", "json"] },
  resume: { summary: "Reopen a workspace and resume its agent session.", usage: ["resume <name> [options]"], options: resumeOptions },
  restart: { summary: "Restart the agent process in an existing workspace.", usage: ["restart <name> [options]"], options: resumeOptions },
  move: { summary: "Move a workspace's tmux window to another session.", usage: ["move <name> --to SESSION"], options: ["name", "to", "json"] },
  rename: { summary: "Rename a workspace and its tmux window, preserving its resource identity.", usage: ["rename <name> <new-name>"], options: ["name", "json"] },
  close: { summary: "Close the workspace session, retaining its worktree and provisioned resources.", usage: ["close <name>"], options: ["name", "json"] },
  delete: { summary: "Deactivate workspace resources and remove its worktree and saved record.", usage: ["delete <name> [options]"], options: ["name", "force", "delete-branch-if-empty", "json"], details: ["Shared worktrees remain while other workspaces reference them.", "Failed resource cleanup stops deletion and retains the ownership records."] },
  refresh: { summary: "Regenerate a workspace's environment and print the resulting file path.", usage: ["refresh <name>"], options: ["json"], details: ["Uses current configuration and existing provisioner outputs; creates no resources.", "To update the current shell: source \"$(pitch refresh NAME)\"."] },
  cleanup: { summary: "Deactivate one provisioner's resources for the selected workspace.", usage: ["cleanup <provisioner> --workspace NAME [options]"], options: ["workspace", "repo", "json"], details: ["Close an active workspace first. Other provisioners are left alone.", "Also supports interrupted creation without a workspace record."] },
  prune: { summary: "Remove expired local provisioner history without contacting remote services.", usage: ["prune <provisioner> [options]"], options: ["repo", "dry-run", "json"], details: ["Preserves workspace-owned records and unresolved cleanup outcomes.", "Expiry uses the recorded retention period plus history_buffer_days."] },
  "status-right": { summary: "Render agent status for the tmux status bar.", usage: ["status-right [options]"], options: ["separator", "tmux-session", "tmux-window", "json"] },
  "waybar-status": { summary: "Render agent status for Waybar, optionally streaming updates.", usage: ["waybar-status [--watch]"], options: ["watch", "json"] },
  view: { summary: "Open the interactive workspace browser.", usage: ["view [options]"], options: ["exit-on-jump", "keep-open-on-jump"] },
  completion: { summary: "Generate zsh completion definitions.", usage: ["completion zsh"], details: ["Reload completion in this shell: source <(pitch completion zsh)."] },
  workspace: { summary: "Optional prefix for Pitch commands; it does not create or select a workspace.", usage: ["workspace <command> [arguments]"], details: ["These pairs are equivalent:", "  pitch workspace show NAME    = pitch show NAME", "  pitch workspace create ...   = pitch create ...", "  pitch workspace delete NAME  = pitch delete NAME", "", "Use pitch workspace <command> --help for that command's help."] },
  help: { summary: "Show help for a command.", usage: ["help <command>", "<command> --help"], details: ["Run pitch with no arguments for the command overview."] },
};

export const helpCommandNames = Object.keys(commands);

export function buildHelpText(positionals: string[] = [], implicitCreate = false): string {
  const words = [...positionals];
  if (words[0] === "help") words.shift();
  const alias = words[0] === "workspace";
  if (alias) words.shift();
  if (words[0] === "help") words.shift();
  const command = implicitCreate && (!words[0] || !Object.hasOwn(commands, words[0])) ? "create"
    : words[0] ?? (alias ? "workspace" : undefined);
  if (!command) {
    const width = Math.max(...Object.keys(commands).map((name) => name.length));
    return ["Pitch manages development workspaces and their coding agents.", "", "Usage: pitch <command> [options]", "", "Commands:",
      ...Object.entries(commands).map(([name, help]) => `  ${name.padEnd(width)}  ${help.summary}`),
      "", "Run pitch <command> --help for usage and options.",
      "Create is implied when --issue, --pr, or --name is supplied."].join("\n");
  }
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}`);
  let help = commands[command];
  if (command === "list") {
    help = words[1] ? {
      summary: "List a provisioner's tracked resources and their workspace ownership.",
      usage: ["list <provisioner> [options]"], options: ["repo", "all", "orphaned", "verify", "json"],
      details: ["Listing reads local records unless --verify is supplied; it never prunes.", "Failed remote verification retains the row and exits with status 1."],
    } : { ...help, options: ["repo", "status", "sort", "group-by", "all", "orphaned", "verify", "json"] };
  }
  const prefix = alias && command !== "workspace" ? "pitch workspace" : "pitch";
  const selected = [...(help.options ?? []), "help"].map((name) => options[name]);
  const width = Math.max(...selected.map(([flag]) => flag.length));
  return [help.summary, "", "Usage:", ...help.usage.map((usage) => `  ${prefix} ${usage}`), "", "Options:",
    ...selected.map(([flag, summary]) => `  ${flag.padEnd(width)}  ${summary}`),
    ...(help.details ? ["", ...help.details] : [])].join("\n");
}
