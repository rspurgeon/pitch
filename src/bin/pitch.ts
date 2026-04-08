#!/usr/bin/env node

import { runCli } from "../cli.js";
import { runClaudeHookFromStdin } from "../claude-hook.js";
import { runCodexHookFromStdin } from "../codex-hook.js";

const args = process.argv.slice(2);
const exitCode =
  args[0] === "codex-hook"
    ? await runCodexHookFromStdin(process.stdin, process.stderr)
    : args[0] === "claude-hook"
      ? await runClaudeHookFromStdin(process.stdin, process.stderr)
    : await runCli(args);
process.exitCode = exitCode;
