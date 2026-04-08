import { once } from "node:events";
import type { Readable } from "node:stream";
import { handleCodexHookPayload } from "./agent-status.js";

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];

  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });

  await once(stream, "end");
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCodexHookFromStdin(
  stdin: Readable,
  stderr: { write(chunk: string): void },
): Promise<number> {
  try {
    const raw = await readAll(stdin);
    const payload = JSON.parse(raw);
    await handleCodexHookPayload(payload);
    return 0;
  } catch (error) {
    stderr.write(
      `pitch codex-hook failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}
