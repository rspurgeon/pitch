import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";

let config;
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

server.tool(
  "ping",
  "Returns pong — used to verify the Pitch MCP server is running",
  {},
  async () => ({
    content: [{ type: "text", text: "pong" }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
