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
  environment: z.string().optional(),
  base_branch: z.string().default("main"),
  worktree_root: z.string().default(DEFAULT_WORKTREE_ROOT),
});

const nullToUndefined = (v: unknown) => (v === null ? undefined : v);

const AgentArgListSchema = z.preprocess(
  nullToUndefined,
  z.array(z.string()).default([]),
);

const NonEmptyTrimmedStringSchema = z.string().trim().min(1);

const AgentEnvSchema = z.preprocess(
  nullToUndefined,
  z.record(z.string(), z.string()).default({}),
);

const AgentTypeSchema = z.enum(["claude", "codex", "opencode"]);
const ExecutionEnvironmentKindSchema = z.enum(["host", "vm-ssh"]);
const SandboxProviderSchema = z.enum(["nono"]);

const AgentConfigSchema = z
  .object({
    type: AgentTypeSchema,
    args: AgentArgListSchema,
    env: AgentEnvSchema,
  })
  .strict();

const AgentOverrideSchema = z
  .object({
    args: AgentArgListSchema,
    env: AgentEnvSchema,
  })
  .strict();

const BootstrapPromptTemplatesSchema = z
  .object({
    issue: z.preprocess(nullToUndefined, z.string().optional()),
    pr: z.preprocess(nullToUndefined, z.string().optional()),
    adhoc: z.preprocess(nullToUndefined, z.string().optional()),
  })
  .strict();

const PaneCommandsSchema = z
  .object({
    top_right: z.preprocess(nullToUndefined, NonEmptyTrimmedStringSchema.optional()),
    bottom_right: z.preprocess(
      nullToUndefined,
      NonEmptyTrimmedStringSchema.optional(),
    ),
  })
  .strict();

const SharedPathModeSchema = z.enum(["ro", "rw"]);

const SharedPathSchema = z.object({
  host_path: NonEmptyTrimmedStringSchema,
  guest_path: NonEmptyTrimmedStringSchema,
  mode: SharedPathModeSchema.default("rw"),
}).strict();

const EnvironmentBootstrapSchema = z.object({
  mise_install: z.boolean().default(false),
}).strict();

const HostExecutionEnvironmentConfigSchema = z.object({
  kind: z.literal("host"),
}).strict();

const VmSshExecutionEnvironmentConfigSchema = z.object({
  kind: z.literal("vm-ssh"),
  ssh_host: NonEmptyTrimmedStringSchema,
  ssh_user: z.preprocess(nullToUndefined, NonEmptyTrimmedStringSchema.optional()),
  ssh_port: z.preprocess(
    nullToUndefined,
    z.number().int().positive().optional(),
  ),
  ssh_identity_file: z.preprocess(
    nullToUndefined,
    NonEmptyTrimmedStringSchema.optional(),
  ),
  ssh_options: z.preprocess(nullToUndefined, z.array(z.string()).default([])),
  libvirt_domain: z.preprocess(
    nullToUndefined,
    NonEmptyTrimmedStringSchema.optional(),
  ),
  guest_workspace_root: NonEmptyTrimmedStringSchema,
  shared_paths: z.preprocess(
    nullToUndefined,
    z.array(SharedPathSchema).default([]),
  ),
  bootstrap: z.preprocess(
    nullToUndefined,
    EnvironmentBootstrapSchema.default({}),
  ),
}).strict();

const ExecutionEnvironmentConfigSchema = z.discriminatedUnion("kind", [
  HostExecutionEnvironmentConfigSchema,
  VmSshExecutionEnvironmentConfigSchema,
]);

const SandboxProfilesSchema = z
  .object({
    claude: z.preprocess(
      nullToUndefined,
      NonEmptyTrimmedStringSchema.optional(),
    ),
    codex: z.preprocess(
      nullToUndefined,
      NonEmptyTrimmedStringSchema.optional(),
    ),
    opencode: z.preprocess(
      nullToUndefined,
      NonEmptyTrimmedStringSchema.optional(),
    ),
  })
  .strict();

const SandboxConfigSchema = z.object({
  provider: SandboxProviderSchema,
  profile: z.preprocess(nullToUndefined, NonEmptyTrimmedStringSchema.optional()),
  profiles: z.preprocess(nullToUndefined, SandboxProfilesSchema.optional()),
  network_profile: z.preprocess(
    nullToUndefined,
    NonEmptyTrimmedStringSchema.optional(),
  ),
  capability_elevation: z.boolean().default(false),
  rollback: z.boolean().default(false),
}).strict();

const RepoConfigSchema = z
  .object({
    default_agent: z.preprocess(nullToUndefined, z.string().optional()),
    default_environment: z.preprocess(nullToUndefined, z.string().optional()),
    sandbox: z.preprocess(nullToUndefined, z.string().optional()),
    main_worktree: z.string(),
    worktree_base: z.preprocess(nullToUndefined, z.string().optional()),
    tmux_session: z.preprocess(nullToUndefined, z.string().optional()),
    additional_paths: z.preprocess(
      nullToUndefined,
      z.array(NonEmptyTrimmedStringSchema).default([]),
    ),
    bootstrap_prompts: z.preprocess(
      nullToUndefined,
      BootstrapPromptTemplatesSchema.default({}),
    ),
    pane_commands: z.preprocess(
      nullToUndefined,
      PaneCommandsSchema.default({}),
    ),
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
  bootstrap_prompts: z.preprocess(
    nullToUndefined,
    BootstrapPromptTemplatesSchema.default({}),
  ),
  repos: z.preprocess(
    nullToUndefined,
    z.record(z.string(), RepoConfigSchema).default({}),
  ),
  environments: z.preprocess(
    nullToUndefined,
    z.record(z.string(), ExecutionEnvironmentConfigSchema).default({}),
  ),
  sandboxes: z.preprocess(
    nullToUndefined,
    z.record(z.string(), SandboxConfigSchema).default({}),
  ),
  agents: z.preprocess(
    nullToUndefined,
    z.record(z.string(), AgentConfigSchema).default({}),
  ),
}).superRefine((config, ctx) => {
  const configuredAgents = new Set(Object.keys(config.agents));
  const configuredEnvironments = new Set(Object.keys(config.environments));
  const configuredSandboxes = new Set(Object.keys(config.sandboxes));

  function addUnknownAgentIssue(path: (string | number)[], agentName: string): void {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Unknown agent reference: ${agentName}`,
    });
  }

  function addUnknownEnvironmentIssue(
    path: (string | number)[],
    environmentName: string,
  ): void {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Unknown environment reference: ${environmentName}`,
    });
  }

  function addUnknownSandboxIssue(
    path: (string | number)[],
    sandboxName: string,
  ): void {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Unknown sandbox reference: ${sandboxName}`,
    });
  }

  if (
    config.defaults.agent !== undefined &&
    !configuredAgents.has(config.defaults.agent)
  ) {
    addUnknownAgentIssue(["defaults", "agent"], config.defaults.agent);
  }

  if (
    config.defaults.environment !== undefined &&
    !configuredEnvironments.has(config.defaults.environment)
  ) {
    addUnknownEnvironmentIssue(
      ["defaults", "environment"],
      config.defaults.environment,
    );
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

    if (
      repoConfig.default_environment !== undefined &&
      !configuredEnvironments.has(repoConfig.default_environment)
    ) {
      addUnknownEnvironmentIssue(
        ["repos", repoName, "default_environment"],
        repoConfig.default_environment,
      );
    }

    if (
      repoConfig.sandbox !== undefined &&
      !configuredSandboxes.has(repoConfig.sandbox)
    ) {
      addUnknownSandboxIssue(
        ["repos", repoName, "sandbox"],
        repoConfig.sandbox,
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
  environment?: string;
  base_branch: string;
  worktree_root: string;
}

export interface RepoConfig {
  default_agent?: string;
  default_environment?: string;
  sandbox?: string;
  main_worktree: string;
  worktree_base: string;
  tmux_session: string;
  additional_paths: string[];
  bootstrap_prompts: BootstrapPromptTemplates;
  pane_commands?: PaneCommands;
  agent_defaults: AgentOverride;
  agent_overrides: Record<string, AgentOverride>;
}

export interface BootstrapPromptTemplates {
  issue?: string;
  pr?: string;
  adhoc?: string;
}

export interface PaneCommands {
  top_right?: string;
  bottom_right?: string;
}

export interface AgentConfig {
  type: AgentType;
  args: string[];
  env: Record<string, string>;
}

export interface SandboxConfig {
  provider: SandboxProvider;
  profile?: string;
  profiles?: Partial<Record<AgentType, string>>;
  network_profile?: string;
  capability_elevation: boolean;
  rollback: boolean;
}

export interface SharedPathConfig {
  host_path: string;
  guest_path: string;
  mode: "ro" | "rw";
}

export interface EnvironmentBootstrapConfig {
  mise_install: boolean;
}

export interface HostExecutionEnvironmentConfig {
  kind: "host";
}

export interface VmSshExecutionEnvironmentConfig {
  kind: "vm-ssh";
  ssh_host: string;
  ssh_user?: string;
  ssh_port?: number;
  ssh_identity_file?: string;
  ssh_options: string[];
  libvirt_domain?: string;
  guest_workspace_root: string;
  shared_paths: SharedPathConfig[];
  bootstrap: EnvironmentBootstrapConfig;
}

export type ExecutionEnvironmentConfig =
  | HostExecutionEnvironmentConfig
  | VmSshExecutionEnvironmentConfig;

export interface AgentOverride {
  args: string[];
  env: Record<string, string>;
}

export interface PitchConfig {
  defaults: Defaults;
  bootstrap_prompts: BootstrapPromptTemplates;
  repos: Record<string, RepoConfig>;
  environments: Record<string, ExecutionEnvironmentConfig>;
  sandboxes: Record<string, SandboxConfig>;
  agents: Record<string, AgentConfig>;
}

export type AgentType = z.infer<typeof AgentTypeSchema>;
export type ExecutionEnvironmentKind = z.infer<
  typeof ExecutionEnvironmentKindSchema
>;
export type SandboxProvider = z.infer<typeof SandboxProviderSchema>;

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
    default_environment: repoConfig.default_environment,
    sandbox: repoConfig.sandbox,
    main_worktree: repoConfig.main_worktree,
    worktree_base:
      repoConfig.worktree_base ?? join(defaults.worktree_root, repoName),
    tmux_session: repoConfig.tmux_session ?? deriveTmuxSession(repoName),
    additional_paths: repoConfig.additional_paths,
    bootstrap_prompts: repoConfig.bootstrap_prompts,
    pane_commands: repoConfig.pane_commands,
    agent_defaults: repoConfig.agent_defaults,
    agent_overrides: repoConfig.agent_overrides,
  };
}

function normalizeConfig(raw: RawPitchConfig): PitchConfig {
  return {
    defaults: {
      repo: raw.defaults.repo,
      agent: raw.defaults.agent,
      environment: raw.defaults.environment,
      base_branch: raw.defaults.base_branch,
      worktree_root: raw.defaults.worktree_root,
    },
    bootstrap_prompts: raw.bootstrap_prompts,
    repos: Object.fromEntries(
      Object.entries(raw.repos).map(([repoName, repoConfig]) => [
        repoName,
        normalizeRepoConfig(repoName, repoConfig, raw.defaults),
      ]),
    ),
    environments: raw.environments,
    sandboxes: raw.sandboxes,
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
