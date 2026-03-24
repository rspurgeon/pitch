import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerCloseWorkspaceTool } from "./close-workspace.js";
import { ConfigError, loadConfig, type PitchConfig } from "./config.js";
import { registerCreateWorkspaceTool } from "./create-workspace.js";
import { registerResumeWorkspaceTool } from "./resume-workspace.js";
import { registerWorkspaceQueryTools } from "./workspace-query.js";

let config: PitchConfig;
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
  version: "0.1.0",
});

server.registerTool(
  "ping",
  {
    description: "Health check — returns server status and config summary",
    inputSchema: z.object({}).strict(),
  },
  async () => {
    const repos = Object.keys(config.repos);
    const agents = Object.keys(config.agents);
    const status = {
      status: "ok",
      version: "0.1.0",
      default_repo: config.defaults.repo ?? null,
      default_agent: config.defaults.agent ?? null,
      repos: repos.length,
      agents: agents.length,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status) }],
    };
  },
);

registerCreateWorkspaceTool(server, config);
registerWorkspaceQueryTools(server);
registerCloseWorkspaceTool(server, config);
registerResumeWorkspaceTool(server, config);

const transport = new StdioServerTransport();
await server.connect(transport);
