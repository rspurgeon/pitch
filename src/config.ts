import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// --- Zod Schemas ---

export const DEFAULT_WORKTREE_ROOT = "~/.local/share/worktrees";

const DefaultsSchema = z.object({
  repo: z.string().optional(),
  agent: z.string().optional(),
  base_branch: z.string().default("main"),
  worktree_root: z.string().default(DEFAULT_WORKTREE_ROOT),
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

const AgentTypeSchema = z.enum(["claude", "codex", "opencode"]);
const AgentRuntimeSchema = z.enum(["native", "docker"]);

const AgentConfigSchema = z
  .object({
    type: AgentTypeSchema,
    runtime: AgentRuntimeSchema,
    args: AgentArgListSchema,
    env: AgentEnvSchema,
  })
  .strict();

const AgentOverrideSchema = z
  .object({
    runtime: AgentRuntimeSchema.optional(),
    args: AgentArgListSchema,
    env: AgentEnvSchema,
  })
  .strict();

const RepoConfigSchema = z
  .object({
    default_agent: z.preprocess(nullToUndefined, z.string().optional()),
    main_worktree: z.string(),
    worktree_base: z.preprocess(nullToUndefined, z.string().optional()),
    tmux_session: z.preprocess(nullToUndefined, z.string().optional()),
    agent_defaults: z.preprocess(
      nullToUndefined,
      AgentOverrideSchema.default({}),
    ),
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
}).superRefine((config, ctx) => {
  const configuredAgents = new Set(Object.keys(config.agents));

  function addUnknownAgentIssue(path: (string | number)[], agentName: string): void {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Unknown agent reference: ${agentName}`,
    });
  }

  if (
    config.defaults.agent !== undefined &&
    !configuredAgents.has(config.defaults.agent)
  ) {
    addUnknownAgentIssue(["defaults", "agent"], config.defaults.agent);
  }

  for (const [repoName, repoConfig] of Object.entries(config.repos)) {
    if (
      repoConfig.default_agent !== undefined &&
      !configuredAgents.has(repoConfig.default_agent)
    ) {
      addUnknownAgentIssue(
        ["repos", repoName, "default_agent"],
        repoConfig.default_agent,
      );
    }

    for (const agentName of Object.keys(repoConfig.agent_overrides)) {
      if (!configuredAgents.has(agentName)) {
        addUnknownAgentIssue(
          ["repos", repoName, "agent_overrides", agentName],
          agentName,
        );
      }
    }
  }
});

type RawPitchConfig = z.infer<typeof PitchConfigSchema>;
type RawDefaults = z.infer<typeof DefaultsSchema>;
type RawRepoConfig = z.infer<typeof RepoConfigSchema>;

// --- Types ---

export interface Defaults {
  repo?: string;
  agent?: string;
  base_branch: string;
  worktree_root: string;
}

export interface RepoConfig {
  default_agent?: string;
  main_worktree: string;
  worktree_base: string;
  tmux_session: string;
  agent_defaults: AgentOverride;
  agent_overrides: Record<string, AgentOverride>;
}

export interface AgentConfig {
  type: AgentType;
  runtime: AgentRuntime;
  args: string[];
  env: Record<string, string>;
}

export interface AgentOverride {
  runtime?: AgentRuntime;
  args: string[];
  env: Record<string, string>;
}

export interface PitchConfig {
  defaults: Defaults;
  repos: Record<string, RepoConfig>;
  agents: Record<string, AgentConfig>;
}

export type AgentType = z.infer<typeof AgentTypeSchema>;
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

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

function deriveTmuxSession(repoName: string): string {
  const parts = repoName.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? repoName;
}

function normalizeRepoConfig(
  repoName: string,
  repoConfig: RawRepoConfig,
  defaults: RawDefaults,
): RepoConfig {
  return {
    default_agent: repoConfig.default_agent,
    main_worktree: repoConfig.main_worktree,
    worktree_base:
      repoConfig.worktree_base ?? join(defaults.worktree_root, repoName),
    tmux_session: repoConfig.tmux_session ?? deriveTmuxSession(repoName),
    agent_defaults: repoConfig.agent_defaults,
    agent_overrides: repoConfig.agent_overrides,
  };
}

function normalizeConfig(raw: RawPitchConfig): PitchConfig {
  return {
    defaults: {
      repo: raw.defaults.repo,
      agent: raw.defaults.agent,
      base_branch: raw.defaults.base_branch,
      worktree_root: raw.defaults.worktree_root,
    },
    repos: Object.fromEntries(
      Object.entries(raw.repos).map(([repoName, repoConfig]) => [
        repoName,
        normalizeRepoConfig(repoName, repoConfig, raw.defaults),
      ]),
    ),
    agents: raw.agents,
  };
}

export async function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<PitchConfig> {
  let rawContent: string;

  try {
    rawContent = await readFile(configPath, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return normalizeConfig(PitchConfigSchema.parse({}));
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
    return normalizeConfig(PitchConfigSchema.parse({}));
  }

  const result = PitchConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid config in ${configPath}:\n${issues}`);
  }

  return normalizeConfig(result.data);
}
