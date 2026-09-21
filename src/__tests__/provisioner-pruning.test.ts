import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { pruneProvisionerHistory } from "../provisioner-pruning.js";
import type { ResourceRecord, ResourceState } from "../workspace-resources.js";
import type { WorkspaceRecord } from "../workspace-state.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pitch-prune-"));
  dirs.push(root);
  const config = await loadConfig(join(root, "absent.yaml"));
  config.provisioners = { example: { create: ["must-not-run"], delete: ["must-not-run"], inspect: ["must-not-run"],
    env_from_files: { SECRET: "/must-not-read" } } };
  const owners: WorkspaceRecord[] = [];
  const deps = { root, now: () => Date.parse("2026-09-19T00:00:00Z"), listWorkspaceRecords: vi.fn(async () => owners) };
  let n = 0;
  async function add(changes: Partial<ResourceRecord> = {}) {
    const id = (++n).toString(16).padStart(32, "0");
    const directory = join(root, id);
    const record: ResourceRecord = { definition: config.provisioners!.example, selection: { inputs: {} }, status: "deactivated",
      cleanup: { outcome: "deactivated", confirmed_at: "2026-09-01T00:00:00Z", retention_days: 1 }, ...changes };
    const state: ResourceState = { version: 1, id, repo: "owner/repo", workspace_name: `workspace-${n}`, completed: true,
      provisioners: { example: record } };
    await mkdir(join(directory, "example"), { recursive: true });
    await writeFile(join(directory, "example", "receipt.json"), "private-receipt");
    await writeFile(join(directory, "environment.sh"), "private-environment");
    await writeFile(join(directory, "resources.json"), JSON.stringify(state));
    return { directory, state, record, id };
  }
  return { root, config, deps, owners, add };
}

describe("local provisioner history pruning", () => {
  it("previews without writing, then removes expired unowned history and assets", async () => {
    const f = await fixture();
    const a = await f.add();
    const before = await readFile(join(a.directory, "resources.json"), "utf8");
    const preview = await pruneProvisionerHistory({ provisioner: "example", dry_run: true }, f.config, f.deps);
    expect(preview.items[0].status).toBe("would prune");
    expect(await readFile(join(a.directory, "resources.json"), "utf8")).toBe(before);
    expect(await readdir(a.directory)).not.toContain(".lock");
    const actual = await pruneProvisionerHistory({ provisioner: "example" }, f.config, f.deps);
    expect(actual.items[0].status).toBe("pruned");
    expect(actual.warnings).toEqual([]);
    await expect(readdir(a.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains recent, unresolved, unknown-policy, and workspace-owned resources", async () => {
    const f = await fixture();
    await f.add({ cleanup: { outcome: "deactivated", confirmed_at: "2026-09-15T00:00:00Z", retention_days: 1 } });
    await f.add({ status: "creating", cleanup: undefined });
    await f.add({ status: "ready", cleanup: undefined });
    await f.add({ cleanup: undefined });
    await f.add({ cleanup: { outcome: "deactivated", confirmed_at: "2026-09-01T00:00:00Z" } });
    const owned = await f.add();
    f.owners.push({ resource_id: owned.id, repo: "owner/repo", name: "renamed", status: "closed" } as WorkspaceRecord);
    const result = await pruneProvisionerHistory({}, f.config, f.deps);
    expect(result.items).toHaveLength(4);
    expect(result.items.every((item) => item.status === "retained")).toBe(true);
    expect(await readdir(f.root)).toHaveLength(6);
  });

  it("uses buffer alone for confirmed never-created records and honors expiry boundaries", async () => {
    const f = await fixture();
    f.config.provisioners!.example.history_buffer_days = 2;
    await f.add({ cleanup: { outcome: "not_created", confirmed_at: "2026-09-17T00:00:00Z" } });
    await f.add({ cleanup: { outcome: "deactivated", confirmed_at: "2026-09-17T00:00:00Z", retention_days: 1 } });
    const result = await pruneProvisionerHistory({}, f.config, f.deps);
    expect(result.items.map((item) => item.status)).toEqual(["pruned", "retained"]);
  });

  it("prunes archived generations without touching the current workspace or its assets", async () => {
    const f = await fixture();
    const a = await f.add();
    await writeFile(join(a.directory, "completed-123.json"), JSON.stringify(a.state));
    a.state.provisioners.example = { ...a.record, status: "ready", cleanup: undefined };
    await writeFile(join(a.directory, "resources.json"), JSON.stringify(a.state));
    f.owners.push({ resource_id: a.id } as WorkspaceRecord);
    const result = await pruneProvisionerHistory({}, f.config, f.deps);
    expect(result.items[0]).toMatchObject({ status: "pruned", record: join(a.directory, "completed-123.json") });
    expect(await readFile(join(a.directory, "example", "receipt.json"), "utf8")).toBe("private-receipt");
    expect(await readFile(join(a.directory, "environment.sh"), "utf8")).toBe("private-environment");
  });

  it("preserves other providers and filters repositories", async () => {
    const f = await fixture();
    const a = await f.add();
    a.state.provisioners.other = { ...a.record, status: "ready", cleanup: undefined };
    await writeFile(join(a.directory, "resources.json"), JSON.stringify(a.state));
    expect((await pruneProvisionerHistory({ provisioner: "example", repo: "different/repo" }, f.config, f.deps)).items).toEqual([]);
    await pruneProvisionerHistory({ provisioner: "example" }, f.config, f.deps);
    const remaining = JSON.parse(await readFile(join(a.directory, "resources.json"), "utf8"));
    expect(Object.keys(remaining.provisioners)).toEqual(["other"]);
    expect(await readFile(join(a.directory, "environment.sh"), "utf8")).toBe("private-environment");
  });

  it("skips locks and malformed records, and refuses unknown providers", async () => {
    const f = await fixture();
    const locked = await f.add();
    await mkdir(join(locked.directory, ".lock"));
    const broken = await f.add();
    await writeFile(join(broken.directory, "resources.json"), "PRIVATE BROKEN JSON");
    const result = await pruneProvisionerHistory({}, f.config, f.deps);
    expect(result.items).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(await readdir(locked.directory)).toContain(".lock");
    await expect(pruneProvisionerHistory({ provisioner: "unknown" }, f.config, f.deps)).rejects.toThrow("Unknown provisioner");
  });

  it("refuses pruning when workspace ownership cannot be read", async () => {
    const f = await fixture();
    const a = await f.add();
    f.deps.listWorkspaceRecords.mockRejectedValue(new Error("unavailable"));
    await expect(pruneProvisionerHistory({}, f.config, f.deps)).rejects.toThrow("unavailable");
    expect(await readdir(a.directory)).toContain("resources.json");
  });
});
