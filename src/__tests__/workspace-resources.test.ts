import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify, parse } from "yaml";
import { loadConfig } from "../config.js";
import { environmentScript, mergeEnvironment } from "../workspace-environment.js";
import { cleanupWorkspaceResources, prepareWorkspaceEnvironment, renderTemplate } from "../workspace-resources.js";

const exec = promisify(execFile);
const directories: string[] = [];
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "pitch-resources-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await temporary();
  const helper = join(dir, "helper.mjs");
  await writeFile(helper, `import { writeFile, appendFile } from 'node:fs/promises';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const r=JSON.parse(input); await appendFile(${JSON.stringify(join(dir, "calls"))}, process.argv[2]+'\\n');
if (process.argv[2]==='create') {
  const pat=r.resource_dir+'/pat'; await writeFile(pat, 'fixture-secret\\n', {mode:0o600});
  console.log(JSON.stringify({name:r.inputs.name,pat_file:pat}));
} else { console.log(JSON.stringify({deactivated:true,retention_days:1})); }
`);
  const configPath = join(dir, "config.yaml");
  const raw = {
    provisioners: { example: { create: [process.execPath, helper, "create"], delete: [process.execPath, helper, "delete"], env: { SERVICE_CREDENTIAL: "fixture-service" } } },
    repos: { "example/repo": { main_worktree: dir, default_context: "ephemeral", env: { SHARED: "repo" }, contexts: {
      static: { env: { SHARED: "static" } },
      ephemeral: {
        provisioners: { example: { inputs: { name: "{{ workspace.name }}_com" } } },
        generated_files: { config: { path: "{{ workspace.resource_dir }}/files/config.yaml", contents: { "{{ provisioners.example.outputs.name }}": { output: "json" } } } },
        env: { SHARED: "context", CONFIG: "{{ files.config }}" },
        env_from_files: { "TOKEN_{{ provisioners.example.outputs.name | env_key }}": "{{ provisioners.example.outputs.pat_file }}" },
      },
    } } },
  };
  await writeFile(configPath, stringify(raw));
  return { dir, raw, config: await loadConfig(configPath), root: join(dir, "resources") };
}

describe("workspace environments and resources", () => {
  it("scopes cleanup to one provisioner and completes only after all are deactivated", async () => {
    const { config, root, dir } = await fixture();
    config.provisioners!.second = structuredClone(config.provisioners!.example);
    config.repos["example/repo"].contexts!.ephemeral.provisioners!.second = { inputs: { name: "second" } };
    const prepared = await prepareWorkspaceEnvironment({ config, root, repo: "example/repo", name: "scoped", allow_create: true });
    const statePath = join(prepared.directory!, "resources.json");
    const before = await readFile(statePath, "utf8");
    await expect(cleanupWorkspaceResources(prepared.resource_id, root, "unknown")).rejects.toThrow("has no resource");
    expect(await readFile(statePath, "utf8")).toBe(before);
    await cleanupWorkspaceResources(prepared.resource_id, root, "example");
    const partial = JSON.parse(await readFile(statePath, "utf8"));
    expect(partial.completed).toBe(false);
    expect(partial.provisioners.example.status).toBe("deactivated");
    expect(partial.provisioners.second.status).toBe("ready");
    await cleanupWorkspaceResources(prepared.resource_id, root, "example");
    expect((await readFile(join(dir, "calls"), "utf8")).match(/delete/g)).toHaveLength(1);
    // Normal workspace deletion still cleans up every remaining provisioner.
    await cleanupWorkspaceResources(prepared.resource_id, root);
    expect(JSON.parse(await readFile(statePath, "utf8")).completed).toBe(true);
    expect((await readFile(join(dir, "calls"), "utf8")).match(/delete/g)).toHaveLength(2);
  });

  it("merges literal and file sources by variable across layers", () => {
    expect(mergeEnvironment({ env: { A: "old", B: "literal" }, env_from_files: { C: "/old" } },
      { env: { C: "new" }, env_from_files: { A: "/new" } })).toEqual({ env: { B: "literal", C: "new" }, env_from_files: { A: "/new" } });
  });

  it.each(["/bin/sh", "/bin/zsh"])("refreshes secrets and removes stale managed variables in %s", async (shell) => {
    const dir = await temporary();
    const secret = join(dir, "secret");
    const file = join(dir, "environment.sh");
    await writeFile(secret, "safe'$(touch never)\n");
    await writeFile(file, environmentScript({ env: { SIMPLE: "new value" }, env_from_files: { TOKEN: secret } }, file, "test", ["SERVICE_CREDENTIAL"]));
    const command = '. "$1" && test -z "${OLD+x}" && test -z "${SERVICE_CREDENTIAL+x}" && test "$SIMPLE" = "new value" && printf "%s" "$TOKEN"';
    const { stdout } = await exec(shell, ["-c", command, "test", file], { env: { ...process.env, PITCH_MANAGED_ENV_NAMES: "OLD SIMPLE", OLD: "old", SERVICE_CREDENTIAL: "private" } });
    expect(stdout).toBe("safe'$(touch never)");
    await writeFile(secret, "rotated\n");
    expect((await exec(shell, ["-c", command, "test", file], { env: process.env })).stdout).toBe("rotated");
  });

  it("creates once, renders project files, reuses on refresh, and cleans up idempotently", async () => {
    const { dir, config, root } = await fixture();
    const input = { config, root, repo: "example/repo", name: "gh-1943", allow_create: true };
    const prepared = await prepareWorkspaceEnvironment(input);
    expect(parse(await readFile(prepared.environment.CONFIG, "utf8"))).toEqual({ "gh-1943_com": { output: "json" } });
    expect((await stat(prepared.environment_file)).mode & 0o777).toBe(0o600);
    expect(await readFile(prepared.environment_file, "utf8")).not.toContain("fixture-secret");
    const { stdout } = await exec("/bin/sh", ["-c", '. "$1" && printf "%s" "$TOKEN_GH_1943_COM"', "test", prepared.environment_file]);
    expect(stdout).toBe("fixture-secret");
    await prepareWorkspaceEnvironment({ ...input, allow_create: false, resource_id: prepared.resource_id });
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\n");
    await cleanupWorkspaceResources(prepared.resource_id, root);
    await cleanupWorkspaceResources(prepared.resource_id, root);
    const completed = JSON.parse(await readFile(join(prepared.directory, "resources.json"), "utf8"));
    expect(completed.provisioners.example.cleanup).toMatchObject({ outcome: "deactivated", retention_days: 1 });
    expect(completed.provisioners.example.cleanup.confirmed_at).toBe(completed.provisioners.example.deactivated_at);
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ndelete\n");
    await expect(prepareWorkspaceEnvironment({ ...input, allow_create: false })).rejects.toThrow("deactivated");
    await prepareWorkspaceEnvironment(input);
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ndelete\ncreate\n");
  });

  it("does not provision static contexts and refuses provisioning during refresh", async () => {
    const { dir, config, root } = await fixture();
    await prepareWorkspaceEnvironment({ config, root, repo: "example/repo", name: "static", context: "static", allow_create: true });
    await expect(readFile(join(dir, "calls"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepareWorkspaceEnvironment({ config, root, repo: "example/repo", name: "new" })).rejects.toThrow("only performed during workspace creation");
  });

  it("rolls back when generated configuration fails and permits a subsequent create", async () => {
    const { dir, config, root } = await fixture();
    const ctx = config.repos["example/repo"].contexts!.ephemeral;
    const original = ctx.generated_files!.config.path;
    ctx.generated_files!.config.path = "/outside/config.yaml";
    await expect(prepareWorkspaceEnvironment({ config, root, repo: "example/repo", name: "broken", allow_create: true })).rejects.toThrow("Generated files");
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ndelete\n");
    ctx.generated_files!.config.path = original;
    await prepareWorkspaceEnvironment({ config, root, repo: "example/repo", name: "broken", allow_create: true });
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ndelete\ncreate\n");
  });

  it("retains ownership when cleanup fails and retries the recorded command", async () => {
    const { config, root } = await fixture();
    const input = { config, root, repo: "example/repo", name: "retry", allow_create: true };
    const prepared = await prepareWorkspaceEnvironment(input);
    const statePath = join(prepared.directory, "resources.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const original = state.provisioners.example.definition.delete;
    state.provisioners.example.definition.delete = [process.execPath, "-e", "process.exit(1)"];
    await writeFile(statePath, JSON.stringify(state));
    await expect(cleanupWorkspaceResources(prepared.resource_id, root)).rejects.toThrow("State retained");
    expect(JSON.parse(await readFile(statePath, "utf8")).provisioners.example.status).toBe("ready");
    state.provisioners.example.definition.delete = original;
    await writeFile(statePath, JSON.stringify(state));
    await cleanupWorkspaceResources(prepared.resource_id, root);
  });

  it("does not record a started provisioner when credential loading fails", async () => {
    const { dir, config, root } = await fixture();
    config.provisioners!.example.env_from_files = { PRIVATE_KEY: join(dir, "missing") };
    await expect(prepareWorkspaceEnvironment({ config, root, repo: "example/repo", name: "missing-credential", allow_create: true })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "calls"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to create another workspace using an existing resource identity", async () => {
    const { dir, config, root } = await fixture();
    const input = { config, root, repo: "example/repo", name: "existing", allow_create: true };
    await prepareWorkspaceEnvironment(input);
    await expect(prepareWorkspaceEnvironment(input)).rejects.toThrow("Resources already exist");
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\n");
  });

  it("rejects missing template values and unsafe keys", () => {
    expect(renderTemplate("{{ workspace.name | env_key }}", { workspace: { name: "gh-1943.v2_com" } })).toBe("GH_1943_V2_COM");
    expect(() => renderTemplate("{{ missing.token }}", {})).toThrow("Unknown template reference");
    expect(() => environmentScript({ env: { "A;echo": "bad" } }, "/file", "name")).toThrow("Invalid environment");
  });
});
