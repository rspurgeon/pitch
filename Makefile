.PHONY: install build clean start lint test inspect ping tools-list

install: ## Install dependencies
	npm install

build: ## Compile TypeScript to dist/
	npm run build

clean: ## Remove build artifacts
	rm -rf dist

start: ## Launch the MCP server
	npm start

lint: ## Type-check without emitting
	npx tsc --noEmit

test: ## Run unit tests
	npx vitest run

inspect: ## Open the MCP Inspector (interactive web UI for testing tools)
	npx @modelcontextprotocol/inspector npx tsx src/index.ts

ping: ## Health check — show server status and config summary
	@printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{}}}\n' | npx tsx src/index.ts 2>/dev/null | tail -1 | jq -r '.result.content[0].text' | jq

tools-list: ## List all registered MCP tools
	@printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | npx tsx src/index.ts 2>/dev/null | tail -1 | jq -r '.result.tools'
