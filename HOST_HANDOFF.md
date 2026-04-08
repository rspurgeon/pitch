# Host Handoff

## Goal

User wants a tmux integration spike for Pitch.

Current preferred direction:

- start with `status-right`
- keep existing tmux layout habits intact
- do not add a persistent sidebar pane yet
- popup navigator can come next
- host tmux is authoritative; this guest VM cannot inspect the real
  tmux server

## Prior Evaluation: `samleeney/tmux-agent-status`

I read the upstream repo and compared it to Pitch's tmux assumptions.

Main findings:

- It is sidebar-first, not popup-first.
- The popup navigator is implemented by
  `scripts/hook-based-switcher.sh` and uses `tmux display-popup`.
- The persistent sidebar is a real tmux split pane created by
  `scripts/sidebar-toggle.sh`, not an overlay.
- The sidebar reads cached status data written by
  `scripts/sidebar-collector.sh`; hooks and process scans populate
  `~/.cache/tmux-agent-status`.
- The popup navigator shows session/window/pane hierarchy and jumps via
  `switch-client`, `select-window`, and `select-pane`.
- Close actions in the upstream plugin are raw tmux kills, not
  Pitch-aware.

Important compatibility result:

- Upstream left sidebar insertion uses `split-window -hbl ...`.
- In an isolated tmux repro, that moved Pitch's existing agent pane
  from pane index `0` to pane index `1`, because the new sidebar became
  pane index `0`.
- Pitch currently assumes the agent stays in pane index `0` during
  create/resume/close flows.

Relevant Pitch files:

- [src/tmux.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/tmux.ts)
- [src/create-workspace.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/create-workspace.ts)
- [src/resume-workspace.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/resume-workspace.ts)
- [src/close-workspace.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/close-workspace.ts)

Useful repro details:

- Baseline Pitch 3-pane layout keeps agent in pane index `0`.
- A full-height right-side pane created with
  `split-window -hf -l 20 ...` preserved the existing pane indices in
  an isolated tmux repro.
- That makes a future right-side monitor more plausible than the
  upstream left sidebar.

## What Was Implemented

I started the `status-right` spike inside Pitch.

New behavior:

- added a new CLI command: `pitch status-right`
- added optional `--separator TEXT`
- command is designed to return an empty string outside Pitch-managed
  tmux sessions so it can be prepended to the user's existing
  `status-right`

Current rendering logic:

- detect current tmux session/window
- load active Pitch workspace records
- filter to the current tmux session
- inspect pane index `0` commands for windows in that session
- classify each workspace window as:
  - `run`: pane `0` command matches expected agent process
  - `idle`: pane `0` command is a shell
  - `other`: pane `0` command is neither expected agent nor shell
  - `missing`: pane `0` not found

Output shape:

- if current window is a Pitch workspace:
  - `P <workspace> <agent> <state> +Nws`
  - example: `P pr-700 codex run +1ws`
- if current window is not a Pitch workspace but current session has
  active Pitch workspaces:
  - `P Nws Xrun Yidle Zother`
  - example: `P 3ws 1run 1idle 1other`
- if not in a Pitch-managed tmux session:
  - empty output

Files added/changed:

- [src/status-right.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/status-right.ts)
- [src/__tests__/status-right.test.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/__tests__/status-right.test.ts)
- [src/cli.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/cli.ts)
- [src/__tests__/cli.test.ts](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/src/__tests__/cli.test.ts)
- [README.md](/srv/pitch-host/worktrees/rspurgeon/pitch/tmux-sidebar/README.md)

README snippet added:

```tmux
set -g status-right '#(pitch status-right --separator " | ")#H #{window_name} #{pane_current_path}'
```

## Current Repo State

At the time of handoff:

- modified: `README.md`
- modified: `src/__tests__/cli.test.ts`
- modified: `src/cli.ts`
- new: `src/__tests__/status-right.test.ts`
- new: `src/status-right.ts`
- untracked local metadata: `.codex`

## Verification Blockers In This Guest VM

I could not finish verification here.

Reasons:

- host tmux is outside this sandbox guest VM, so I could not inspect the
  user's real `pitch` / `kongctl` sessions directly
- this worktree did not have `node_modules`
- `make test` and `make build` initially failed because `vitest` and
  `tsc` were unavailable
- `make install` failed inside the sandbox due npm cache writes hitting
  a read-only location under `/home/rspurgeon/.npm`
- I requested an escalated re-run, but the user intentionally aborted
  the turn because they want to transition to the outer host agent

Concrete command failures:

- `make build` -> `tsc: not found`
- `make test` -> `ERR_MODULE_NOT_FOUND` for `vitest`
- `make install` -> `EROFS` writing npm cache under
  `/home/rspurgeon/.npm/_cacache/...`

## Recommended Next Steps For The Outer Host Agent

1. Verify the current diff and decide whether to keep the exact output
   wording.
2. On the host, run:
   - `make install`
   - `make test`
   - `make build`
3. If tests/typecheck fail, fix any issues in:
   - `src/status-right.ts`
   - `src/cli.ts`
   - the new tests
4. Try the tmux wiring on the host's real tmux server:
   - prepend `#(pitch status-right --separator " | ")` to the user's
     existing `status-right`
5. Evaluate whether the current output is informative enough in:
   - cockpit windows
   - active workspace windows
   - non-Pitch sessions
6. If the user likes the status-right mechanics, implement the popup
   navigator next.

## Notes For The Next Phase

Likely next increment after `status-right`:

- add a popup navigator, probably as another CLI/subcommand or script
  driven from Pitch workspace state
- keep it popup-only first so it does not mutate pane layout
- later, add Codex hooks and runtime agent state
- later still, if needed, revisit a persistent right-side monitor pane

If a persistent pane comes back into scope, prefer a right-side
full-height pane over a left-side one because the left-side insertion
breaks Pitch's current pane-index assumptions.
