import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify, parse } from "yaml";
import { loadConfig } from "../config.js";
import { environmentScript, mergeEnvironment } from "../workspace-environment.js";
import { cleanupWorkspaceResources, prepareWorkspaceEnvironment, renderTemplate } from "../workspace-resources.js";
import { pruneProvisionerHistory } from "../provisioner-pruning.js";

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
  await writeFile(helper, `import { writeFile, appendFile, readFile } from 'node:fs/promises';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const r=JSON.parse(input); await appendFile(${JSON.stringify(join(dir, "calls"))}, process.argv[2]+'\\n');
if (process.argv[2]==='create') {
  if(r.resource_dir.includes('generation-')) {
    await writeFile(r.resource_dir+'/receipt', 'registered');
    if (await readFile(${JSON.stringify(join(dir, "fail-create"))}, 'utf8').catch(()=>'')) process.exit(1);
  }
  const pat=r.resource_dir+'/pat'; await writeFile(pat, 'fixture-secret\\n', {mode:0o600});
  console.log(JSON.stringify({name:r.inputs.name,pat_file:pat,id:r.resource_dir}));
} else if (process.argv[2]==='inspect') {
  const remote=await readFile(${JSON.stringify(join(dir, "remote"))}, 'utf8').catch(()=>'inactive');
  console.log(JSON.stringify({verified:remote!=='unknown',remote_state:remote,reprovisionable:remote==='inactive'}));
} else {
  if (await readFile(${JSON.stringify(join(dir, "fail-delete"))}, 'utf8').catch(()=>'')) process.exit(1);
  console.log(JSON.stringify({deactivated:true,retention_days:1}));
}
`);
  const configPath = join(dir, "config.yaml");
  const raw = {
    provisioners: { example: { create: [process.execPath, helper, "create"], delete: [process.execPath, helper, "delete"], inspect: [process.execPath, helper, "inspect"], env: { SERVICE_CREDENTIAL: "fixture-service" } } },
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
  it("releases stuck ownership explicitly without invoking helpers or claiming remote cleanup", async () => {
    const root = await temporary();
    const id = "a".repeat(32);
    const directory = join(root, id);
    await mkdir(directory);
    const path = join(directory, "resources.json");
    const record = { definition: { create: ["must-not-run"], delete: ["must-not-run"],
      env_from_files: { SECRET: "/must-not-read" } }, selection: { inputs: {} }, status: "ready" };
    await writeFile(path, JSON.stringify({ version: 1, id, repo: "owner/repo", workspace_name: "stuck",
      provisioners: { example: record, other: record } }));
    await mkdir(join(directory, "example"));
    await writeFile(join(directory, "example", "receipt.json"), "ownership receipt");
    await writeFile(join(directory, "environment.sh"), "old environment");
    await expect(cleanupWorkspaceResources(id, root, "example", " ")).rejects.toThrow("reason");
    await expect(cleanupWorkspaceResources(id, root, undefined, "reason")).rejects.toThrow("one provisioner");
    await cleanupWorkspaceResources(id, root, "example", "Confirmed gone by service team");
    const first = JSON.parse(await readFile(path, "utf8"));
    expect(first.provisioners.example).toMatchObject({ status: "deactivated",
      cleanup: { outcome: "abandoned", reason: "Confirmed gone by service team", confirmed_at: expect.any(String) } });
    expect(first.provisioners.example.deactivated_at).toBeUndefined();
    expect(first.provisioners.other).toEqual(record);
    expect(first.completed).toBe(false);
    await expect(readFile(join(directory, "environment.sh"))).rejects.toMatchObject({ code: "ENOENT" });
    await cleanupWorkspaceResources(id, root, "example", "Second attempt");
    expect(JSON.parse(await readFile(path, "utf8")).provisioners.example).toEqual(first.provisioners.example);
    await cleanupWorkspaceResources(id, root, "other", "Explicit local release");
    // A subsequent delete skips both helpers, even with inaccessible credentials.
    await cleanupWorkspaceResources(id, root);
    expect(JSON.parse(await readFile(path, "utf8")).completed).toBe(true);
    const config = await loadConfig(join(root, "absent.yaml"));
    const pruned = await pruneProvisionerHistory({}, config, { root,
      listWorkspaceRecords: async () => [], now: () => Date.now() + 8 * 86400000 });
    expect(pruned.items.map((item) => item.status)).toEqual(["pruned", "pruned"]);
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces only the selected inactive resource, archives its identity, and refreshes credential paths", async () => {
    const { config, root } = await fixture();
    config.provisioners!.second = structuredClone(config.provisioners!.example);
    config.repos["example/repo"].contexts!.ephemeral.provisioners!.second = { inputs: { name: "second" } };
    const input = { config, root, repo: "example/repo", name: "original" };
    const first = await prepareWorkspaceEnvironment({ ...input, allow_create: true });
    const statePath = join(first.directory, "resources.json");
    const before = JSON.parse(await readFile(statePath, "utf8"));
    const replacement = await prepareWorkspaceEnvironment({ ...input, name: "renamed", resource_id: first.resource_id, reprovision: "example" });
    const after = JSON.parse(await readFile(statePath, "utf8"));
    expect(replacement.resource_id).toBe(first.resource_id);
    expect(after.provisioners.example.outputs.name).toBe("original_com");
    expect(after.provisioners.example.outputs.id).not.toBe(before.provisioners.example.outputs.id);
    expect(after.provisioners.second).toEqual(before.provisioners.second);
    expect(after.reprovision).toBeUndefined();
    expect(await readFile(replacement.environment_file, "utf8")).toContain(after.provisioners.example.outputs.pat_file);
    const archives = (await readdir(first.directory)).filter((name) => name.startsWith("completed-"));
    expect(archives).toHaveLength(1);
    const archive = JSON.parse(await readFile(join(first.directory, archives[0]), "utf8"));
    expect(Object.keys(archive.provisioners)).toEqual(["example"]);
    expect(archive.provisioners.example).toMatchObject({ status: "deactivated", outputs: before.provisioners.example.outputs });
  });

  it.each(["active", "unknown"])("refuses replacement of %s resources without changing receipts", async (remote) => {
    const { config, root, dir } = await fixture();
    const input = { config, root, repo: "example/repo", name: "test" };
    const first = await prepareWorkspaceEnvironment({ ...input, allow_create: true });
    const before = await readFile(join(first.directory, "resources.json"), "utf8");
    await writeFile(join(dir, "remote"), remote);
    await expect(prepareWorkspaceEnvironment({ ...input, reprovision: "example" })).rejects.toThrow("has not confirmed");
    expect(await readFile(join(first.directory, "resources.json"), "utf8")).toBe(before);
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ninspect\n");
  });

  it("retries interrupted creation in the same generation and blocks refresh and cleanup meanwhile", async () => {
    const { config, root, dir } = await fixture();
    const input = { config, root, repo: "example/repo", name: "test" };
    const first = await prepareWorkspaceEnvironment({ ...input, allow_create: true });
    await writeFile(join(dir, "fail-create"), "fail");
    await expect(prepareWorkspaceEnvironment({ ...input, reprovision: "example" })).rejects.toThrow("create failed");
    const pending = JSON.parse(await readFile(join(first.directory, "resources.json"), "utf8"));
    expect(pending.reprovision.phase).toBe("creating");
    await expect(readFile(first.environment_file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepareWorkspaceEnvironment(input)).rejects.toThrow("Reprovision is pending");
    await expect(cleanupWorkspaceResources(first.resource_id, root)).rejects.toThrow("pending reprovision");
    await rm(join(dir, "fail-create"));
    await prepareWorkspaceEnvironment({ ...input, reprovision: "example" });
    const final = JSON.parse(await readFile(join(first.directory, "resources.json"), "utf8"));
    expect(final.provisioners.example.generation).toBe(pending.provisioners.example.generation);
    expect((await readdir(first.directory)).filter((name) => name.startsWith("completed-"))).toHaveLength(1);
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ninspect\ndelete\ncreate\ncreate\n");
  });

  it("retries failed environment rendering without creating another replacement", async () => {
    const { config, root, dir } = await fixture();
    const input = { config, root, repo: "example/repo", name: "test" };
    const first = await prepareWorkspaceEnvironment({ ...input, allow_create: true });
    const context = config.repos["example/repo"].contexts!.ephemeral;
    context.env!.BROKEN = "{{ missing.value }}";
    await expect(prepareWorkspaceEnvironment({ ...input, reprovision: "example" })).rejects.toThrow("Unknown template");
    expect(JSON.parse(await readFile(join(first.directory, "resources.json"), "utf8")).reprovision.phase).toBe("refreshing");
    delete context.env!.BROKEN;
    await prepareWorkspaceEnvironment({ ...input, reprovision: "example" });
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ninspect\ndelete\ncreate\n");
  });

  it("retains old ownership when retirement fails and reuses the operation on retry", async () => {
    const { config, root, dir } = await fixture();
    const input = { config, root, repo: "example/repo", name: "test" };
    const first = await prepareWorkspaceEnvironment({ ...input, allow_create: true });
    const statePath = join(first.directory, "resources.json");
    const before = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(join(dir, "fail-delete"), "fail");
    await expect(prepareWorkspaceEnvironment({ ...input, reprovision: "example" })).rejects.toThrow("delete failed");
    const pending = JSON.parse(await readFile(statePath, "utf8"));
    expect(pending.provisioners).toEqual(before.provisioners);
    expect(pending.reprovision.phase).toBe("retiring");
    await rm(join(dir, "fail-delete"));
    await prepareWorkspaceEnvironment({ ...input, reprovision: "example" });
    const after = JSON.parse(await readFile(statePath, "utf8"));
    expect(after.provisioners.example.generation).toBe(pending.reprovision.generation);
    expect(await readFile(join(dir, "calls"), "utf8")).toBe("create\ninspect\ndelete\ndelete\ncreate\n");
    expect((await readdir(first.directory)).filter((name) => name.startsWith("completed-"))).toEqual([pending.reprovision.archive]);
  });
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
