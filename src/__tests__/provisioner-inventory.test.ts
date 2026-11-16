import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { formatProvisionerInventory, listProvisionerInventory, provisionerCompletionNames } from "../provisioner-inventory.js";
import { inspectWorkspaceResource as inspectResource, type ResourceState } from "../workspace-resources.js";
import type { WorkspaceRecord } from "../workspace-state.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pitch-inventory-"));
  directories.push(root);
  const config = await loadConfig(join(root, "absent.yaml"));
  config.provisioners = { example: { create: ["unused-create"], delete: ["unused-delete"], inspect: ["unused-inspect"] } };
  const owners: WorkspaceRecord[] = [];
  const listWorkspaceRecords = vi.fn(async () => owners);
  const inspectWorkspaceResource = vi.fn<typeof inspectResource>(async (record, _state, _directory, _name, _command, verify, archived) => ({
    id: record.outputs?.id, name: record.outputs?.name, environment: "prod", created_at: record.created_at,
    remote_state: verify ? "active" : null, verified: verify, archived,
    pat: "SHOULD-NEVER-BE-PRINTED", client_secret: "SHOULD-NEVER-BE-PRINTED",
  }));
  let nextId = 0;
  async function add(name: string, status: "creating" | "ready" | "deactivated" = "ready", repo = "owner/repo") {
    const id = (++nextId).toString(16).padStart(32, "0");
    const directory = join(root, id);
    const state: ResourceState = {
      version: 1, id, repo, workspace_name: name, completed: status === "deactivated",
      provisioners: { example: {
        definition: { ...config.provisioners!.example, env_from_files: { SECRET: "/missing-secret-file" } },
        selection: { inputs: { secret: "SHOULD-NEVER-BE-PRINTED" } }, status,
        created_at: "2026-09-01T10:00:00.000Z", outputs: { id: `remote-${id}`, name: `${name}-resource`, pat: "SHOULD-NEVER-BE-PRINTED" },
      } },
    };
    await mkdir(directory);
    await writeFile(join(directory, "resources.json"), JSON.stringify(state));
    return { id, directory, state };
  }
  function attach(id: string, name: string, status: "active" | "closed" = "active") {
    owners.push({ resource_id: id, name, status, repo: "owner/repo" } as WorkspaceRecord);
  }
  return { root, config, owners, add, attach, deps: { root, listWorkspaceRecords, inspectWorkspaceResource } };
}

describe("provisioner inventory", () => {
  it("distinguishes abandoned ownership from confirmed deactivation", async () => {
    const f = await fixture();
    const a = await f.add("abandoned", "deactivated");
    a.state.provisioners.example.cleanup = { outcome: "abandoned", confirmed_at: "2026-09-15T00:00:00Z", reason: "Released intentionally" };
    await writeFile(join(a.directory, "resources.json"), JSON.stringify(a.state));
    expect((await listProvisionerInventory({ provisioner: "example" }, f.config, f.deps)).items).toEqual([]);
    const result = await listProvisionerInventory({ provisioner: "example", all: true }, f.config, f.deps);
    expect(result.items[0]).toMatchObject({ status: "abandoned", abandonment_reason: "Released intentionally", remote_state: null });
    expect(formatProvisionerInventory(result)).toContain("abandoned");
  });

  it("completes retained types and unfinished workspace names without invoking inspectors", async () => {
    const f = await fixture();
    await f.add("unfinished", "creating");
    await f.add("finished", "deactivated");
    expect(await provisionerCompletionNames(f.root)).toEqual({ provisioners: ["example"], workspaces: ["unfinished"] });
    expect(f.deps.inspectWorkspaceResource).not.toHaveBeenCalled();
  });
  it("matches ownership by resource ID, preserving closed and renamed workspaces", async () => {
    const f = await fixture();
    const active = await f.add("active"); f.attach(active.id, "active");
    const closed = await f.add("closed"); f.attach(closed.id, "closed", "closed");
    const renamed = await f.add("old-name"); f.attach(renamed.id, "new-name");
    await f.add("missing");
    await f.add("active"); // A matching name with a different ID is still orphaned.
    await f.add("partial", "creating");
    await f.add("cleaned", "deactivated");
    const result = await listProvisionerInventory({ provisioner: "example" }, f.config, f.deps);
    expect(result.items).toHaveLength(6);
    expect(result.items.find((row) => row.resource_id === active.id)?.status).toBe("active workspace");
    expect(result.items.find((row) => row.resource_id === closed.id)?.status).toBe("closed workspace");
    expect(result.items.find((row) => row.resource_id === renamed.id)).toMatchObject({ workspace: "new-name", orphaned: false });
    const orphaned = await listProvisionerInventory({ provisioner: "example", orphaned: true, all: true }, f.config, f.deps);
    expect(orphaned.items.map((row) => row.workspace)).toEqual(["active", "missing", "partial"]);
    expect(orphaned.items.find((row) => row.workspace === "partial")?.lifecycle).toBe("creating");
    expect(JSON.stringify(result)).not.toContain("SHOULD-NEVER-BE-PRINTED");
    expect(formatProvisionerInventory(result)).not.toContain("SHOULD-NEVER-BE-PRINTED");
    expect(f.deps.inspectWorkspaceResource.mock.calls.every((call) => call[5] === false)).toBe(true);
  });

  it("includes archived generations with --all without attaching them to a new workspace", async () => {
    const f = await fixture();
    const current = await f.add("reused"); f.attach(current.id, "reused");
    const old = structuredClone(current.state);
    old.completed = true;
    old.provisioners.example.status = "deactivated";
    old.provisioners.example.outputs = { id: "old-id", name: "old-resource" };
    await writeFile(join(current.directory, "completed-123.json"), JSON.stringify(old));
    const result = await listProvisionerInventory({ provisioner: "example", all: true }, f.config, f.deps);
    expect(result.items).toHaveLength(2);
    expect(result.items.find((row) => row.archived)).toMatchObject({ id: "old-id", status: "deactivated", orphaned: false, workspace_status: "missing" });
    expect(f.deps.inspectWorkspaceResource.mock.calls.some((call) => call[6] === true)).toBe(true);
  });

  it("retains local metadata and reports failed verification without exposing helper errors", async () => {
    const f = await fixture();
    const a = await f.add("a");
    await f.add("b");
    const before = await readFile(join(a.directory, "resources.json"), "utf8");
    f.deps.inspectWorkspaceResource.mockImplementation(async (record, _s, _d, _n, _c, verify) => {
      if (verify && record.outputs?.name === "a-resource") throw new Error("SHOULD-NEVER-BE-PRINTED");
      return { name: record.outputs?.name, id: record.outputs?.id, verified: verify, remote_state: verify ? "inactive" : null };
    });
    const result = await listProvisionerInventory({ provisioner: "example", verify: true }, f.config, f.deps);
    expect(result.items[0]).toMatchObject({ name: "a-resource", verification: "failed" });
    expect(result.items[1]).toMatchObject({ remote_state: "inactive", verification: "verified", status: "orphaned" });
    expect(JSON.stringify(result)).not.toContain("SHOULD-NEVER-BE-PRINTED");
    expect(await readFile(join(a.directory, "resources.json"), "utf8")).toBe(before);
  });

  it("lists locally with unreadable service credential files and makes verification failure explicit", async () => {
    const f = await fixture();
    await f.add("local");
    const script = join(f.root, "inspect.mjs");
    await writeFile(script, 'let input=""; for await(const part of process.stdin) input+=part; const request=JSON.parse(input); console.log(JSON.stringify({id:request.outputs.id,name:request.outputs.name}));');
    f.config.provisioners!.example.inspect = [process.execPath, script];
    const deps = { root: f.root, listWorkspaceRecords: f.deps.listWorkspaceRecords };
    const local = await listProvisionerInventory({ provisioner: "example" }, f.config, deps);
    expect(local.items[0].name).toBe("local-resource");
    expect(local.warnings).toEqual([]);
    const verified = await listProvisionerInventory({ provisioner: "example", verify: true }, f.config, deps);
    expect(verified.items[0]).toMatchObject({ name: "local-resource", verification: "failed" });
    expect(verified.warnings[0]).toContain("local-resource: ");
    expect(verified.warnings[0]).toContain("SECRET: file missing (/missing-secret-file)");
    expect(verified.warnings[0]).toContain("env_from_files");
    expect(verified.warnings[0]).toContain(verified.items[0].record);
  });

  it("explains missing IDs before attempting credential loading or remote verification", async () => {
    const f = await fixture();
    const record = await f.add("smoke", "deactivated");
    const before = await readFile(join(record.directory, "resources.json"), "utf8");
    f.deps.inspectWorkspaceResource.mockResolvedValue({
      name: "smoke-resource", id: null, verification_error: { code: "missing_resource_id" },
    });
    const result = await listProvisionerInventory({ provisioner: "example", all: true, verify: true }, f.config, f.deps);
    expect(f.deps.inspectWorkspaceResource).toHaveBeenCalledTimes(1);
    expect(f.deps.inspectWorkspaceResource.mock.calls[0][5]).toBe(false);
    expect(result.items[0]).toMatchObject({ verification: "failed", remote_state: null, status: "deactivated" });
    expect(result.warnings[0]).toContain("smoke-resource");
    expect(result.warnings[0]).toContain("Missing or invalid resource ID; verification skipped");
    expect(result.warnings[0]).toContain("Review the creation record before cleanup");
    expect(result.warnings[0]).toContain(join(record.directory, "resources.json"));
    expect(await readFile(join(record.directory, "resources.json"), "utf8")).toBe(before);
  });

  it.each([
    [{ code: "http_error", phase: "token_exchange", status: 403 }, "Resource token exchange: HTTP 403", "permissions"],
    [{ code: "http_error", phase: "state_lookup", status: 404 }, "Remote state lookup: HTTP 404", "deactivation is unconfirmed"],
    [{ code: "missing_credentials", phase: "authentication" }, "missing credentials", "env_from_files"],
    [{ code: "transport_error" }, "connection or timeout error", "network access"],
    [{ code: "invalid_response" }, "unexpected response", "service team"],
    [{ code: "SHOULD-NEVER-BE-PRINTED", phase: "SHOULD-NEVER-BE-PRINTED" }, "Remote state unconfirmed", "receipt"],
    [{ code: "http_error", status: "SHOULD-NEVER-BE-PRINTED" }, "Remote state unconfirmed", "receipt"],
  ])("renders safe diagnostics and next steps for %j", async (diagnostic, cause, advice) => {
    const f = await fixture();
    await f.add("failure");
    f.deps.inspectWorkspaceResource.mockImplementation(async (_r, _s, _d, _n, _c, verify) => ({
      name: "failure-resource", id: "remote-id", verified: false,
      ...(verify ? { verification_error: { ...diagnostic, message: "SHOULD-NEVER-BE-PRINTED" } } : {}),
    }));
    const result = await listProvisionerInventory({ provisioner: "example", verify: true }, f.config, f.deps);
    expect(result.warnings[0]).toContain(cause);
    expect(result.warnings[0]).toContain(advice);
    expect(JSON.stringify(result)).not.toContain("SHOULD-NEVER-BE-PRINTED");
  });

  it("filters by repository and rejects unknown names with available choices", async () => {
    const f = await fixture();
    await f.add("a"); await f.add("b", "ready", "other/repo");
    const result = await listProvisionerInventory({ provisioner: "example", repo: "other/repo" }, f.config, f.deps);
    expect(result.items.map((row) => row.workspace)).toEqual(["b"]);
    await expect(listProvisionerInventory({ provisioner: "unknown" }, f.config, f.deps)).rejects.toThrow("Available provisioners: example");
  });

  it("reports damaged resource records and refuses orphan classification if workspace records cannot be read", async () => {
    const f = await fixture();
    const resource = await f.add("broken");
    await writeFile(join(resource.directory, "resources.json"), "invalid-SHOULD-NEVER-BE-PRINTED");
    const result = await listProvisionerInventory({ provisioner: "example" }, f.config, f.deps);
    expect(result.warnings).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SHOULD-NEVER-BE-PRINTED");
    f.deps.listWorkspaceRecords.mockRejectedValue(new Error("private state"));
    await expect(listProvisionerInventory({ provisioner: "example", orphaned: true }, f.config, f.deps)).rejects.toThrow("refusing to classify");
  });

  it("supports an empty inventory and receipts from provisioners removed from config", async () => {
    const f = await fixture();
    const empty = await listProvisionerInventory({ provisioner: "example" }, f.config, f.deps);
    expect(formatProvisionerInventory(empty)).toBe("No matching example records.\n");
    await f.add("retired");
    f.config.provisioners = {};
    expect((await listProvisionerInventory({ provisioner: "example" }, f.config, f.deps)).items).toHaveLength(1);
  });
});
