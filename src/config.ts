import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// --- Zod Schemas ---

const DefaultsSchema = z.object({
  repo: z.string().optional(),
  agent: z.string().optional(),
  base_branch: z.string().default("main"),
});

const nullToUndefined = (v: unknown) => (v === null ? undefined : v);

const AgentArgListSchema = z.preprocess(
  nullToUndefined,
  z.array(z.string()).default([]),
);

const AgentEnvSchema = z.preprocess(
  nullToUndefined,
  z.record(z.string(), z.string()).default({}),
);

const AgentConfigSchema = z
  .object({
    runtime: z.enum(["native", "docker"]),
    args: AgentArgListSchema,
    env: AgentEnvSchema,
  })
  .strict();

const AgentProfileSchema = z
  .object({
    agent: z.string(),
    runtime: z.enum(["native", "docker"]).optional(),
    args: AgentArgListSchema,
    env: AgentEnvSchema,
  })
  .strict();

const AgentOverrideSchema = z
  .object({
    runtime: z.enum(["native", "docker"]).optional(),
    args: AgentArgListSchema,
    env: AgentEnvSchema,
  })
  .strict();

const RepoConfigSchema = z
  .object({
    main_worktree: z.string(),
    worktree_base: z.string(),
    tmux_session: z.string(),
    agent_overrides: z.preprocess(
      nullToUndefined,
      z.record(z.string(), AgentOverrideSchema).default({}),
    ),
  })
  .strict();

export const PitchConfigSchema = z.object({
  defaults: z.preprocess(nullToUndefined, DefaultsSchema.default({})),
  repos: z.preprocess(
    nullToUndefined,
    z.record(z.string(), RepoConfigSchema).default({}),
  ),
  agents: z.preprocess(
    nullToUndefined,
    z.record(z.string(), AgentConfigSchema).default({}),
  ),
  agent_profiles: z.preprocess(
    nullToUndefined,
    z.record(z.string(), AgentProfileSchema).default({}),
  ),
});

// --- Types (inferred from Zod) ---

export type PitchConfig = z.infer<typeof PitchConfigSchema>;
export type Defaults = z.infer<typeof DefaultsSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type AgentOverride = z.infer<typeof AgentOverrideSchema>;

// --- Error class ---

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// --- Config loader ---

const DEFAULT_CONFIG_PATH = join(homedir(), ".pitch", "config.yaml");

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<PitchConfig> {
  let rawContent: string;

  try {
    rawContent = await readFile(configPath, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return PitchConfigSchema.parse({});
    }
    throw new ConfigError(
      `Failed to read config file at ${configPath}: ${String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawContent);
  } catch (err: unknown) {
    throw new ConfigError(
      `Failed to parse YAML in ${configPath}: ${String(err)}`,
    );
  }

  if (parsed === null || parsed === undefined) {
    return PitchConfigSchema.parse({});
  }

  const result = PitchConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config in ${configPath}:\n${issues}`);
  }

  return result.data;
}
