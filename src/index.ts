#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  registerCloseWorkspaceTool,
  registerDeleteWorkspaceTool,
} from "./close-workspace.js";
import { ConfigError, loadConfig, type PitchConfig } from "./config.js";
import { registerCreateWorkspaceTool } from "./create-workspace.js";
import { getRuntimeMetadata } from "./metadata.js";
import { registerResumeWorkspaceTool } from "./resume-workspace.js";
import { registerWorkspaceQueryTools } from "./workspace-query.js";

let config: PitchConfig;
const runtimeMetadata = await getRuntimeMetadata();
try {
  config = await loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`pitch: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const server = new McpServer({
  name: "pitch",
  version: runtimeMetadata.version,
});

async function buildPingPayload(): Promise<Record<string, unknown>> {
  const repos = Object.keys(config.repos);
  const agents = Object.keys(config.agents);

  return {
    status: "ok",
    version: runtimeMetadata.version,
    default_repo: config.defaults.repo ?? null,
    default_agent: config.defaults.agent ?? null,
    repos: repos.length,
    agents: agents.length,
    git_commit: runtimeMetadata.git_commit,
    git_commit_short: runtimeMetadata.git_commit_short,
    git_branch: runtimeMetadata.git_branch,
    git_dirty: runtimeMetadata.git_dirty,
    launch_mode: runtimeMetadata.launch_mode,
    entrypoint: runtimeMetadata.entrypoint,
    repo_root: runtimeMetadata.repo_root,
  };
}

server.registerTool(
  "ping",
  {
    description:
      "Health check — returns server status, config summary, and runtime identity metadata",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    return {
      content: [{ type: "text", text: JSON.stringify(await buildPingPayload()) }],
    };
  },
);

registerCreateWorkspaceTool(server, config);
registerWorkspaceQueryTools(server);
registerCloseWorkspaceTool(server, config);
registerDeleteWorkspaceTool(server, config);
registerResumeWorkspaceTool(server, config);

const transport = new StdioServerTransport();
await server.connect(transport);
