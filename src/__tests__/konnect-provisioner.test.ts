import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The example helper is standalone JavaScript, usable without Pitch's build.
import { runProvisioner } from "../../examples/provisioners/konnect-org.mjs";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const organizationId = "1ebffe74-5dc8-43d5-8f36-47ce10ee00c9";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pitch-konnect-"));
  dirs.push(dir);
  let inactive = false;
  const users: { id: string; email: string }[] = [];
  const fetch = vi.fn(async (url: string, options: { body?: string; method: string }) => {
    const path = new URL(url).pathname;
    let body: unknown = {};
    let status = 200;
    if (path.endsWith("/client-authentication")) body = { token: { access_token: "service-token" } };
    else if (path.endsWith("/register")) { status = 201; body = { organization_id: organizationId, user_id: "owner-id", konnect_token: "private-pat" }; }
    else if (path.endsWith("/org-token-exchange")) body = { access_token: "org-token" };
    else if (path.endsWith("/history")) body = { data: [{ state: inactive ? "inactive" : "active" }] };
    else if (path.endsWith("/deletion-config")) body = { retention_period_days: 1 };
    else if (path.endsWith("/state") && options.method === "POST") inactive = true;
    else if (path === "/v3/users") body = { data: users, meta: { page: { total: users.length } } };
    else if (path === "/v3/invites") {
      const email = JSON.parse(options.body!).email;
      const id = `user-${users.length + 1}`;
      users.push({ id, email });
      status = 201;
      body = { user_id: id };
    }
    else throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify(body), { status });
  });
  return { dir, fetch, options: { fetch, env: { KAUTH_CLIENT_ID: "client", KAUTH_CLIENT_SECRET_PROD: "secret" } },
    request: { version: 1, workspace: { id: "a".repeat(32), repo: "example/repo" }, resource_dir: dir,
      inputs: { environment: "prod", organization_name: "example_com", owner_email: "quality@example.com" } } };
}

describe("Konnect example provisioner", () => {
  it("invites configured users with the org PAT and avoids reinviting existing users", async () => {
    const { request, options, fetch, dir } = await fixture();
    const configured = { ...request, inputs: { ...request.inputs,
      user_emails: ["quality+one@example.com", "quality+two@example.com", "quality+one@example.com"] } };
    await runProvisioner("create", configured, options);
    await runProvisioner("create", configured, { ...options, env: {} });
    const invites = fetch.mock.calls.filter(([url]) => new URL(url).pathname === "/v3/invites");
    expect(invites).toHaveLength(2);
    for (const [, init] of invites) expect(init).toMatchObject({ headers: { Authorization: "Bearer private-pat" } });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/register"))).toHaveLength(1);
    const receipt = JSON.parse(await readFile(join(dir, "receipt.json"), "utf8"));
    expect(receipt.status).toBe("ready");
    expect(receipt.invited_users).toHaveLength(2);
  });

  it("recovers an uncertain invitation using membership without repeating registration or invitation", async () => {
    const { request, options, fetch, dir } = await fixture();
    const configured = { ...request, inputs: { ...request.inputs, user_emails: ["quality+one@example.com"] } };
    const interruptedFetch = async (url: string, init: { body?: string; method: string }) => {
      const response = await fetch(url, init);
      if (url.endsWith("/invites")) throw new Error("connection lost after invitation");
      return response;
    };
    await expect(runProvisioner("create", configured, { ...options, fetch: interruptedFetch })).rejects.toThrow("uncertain");
    expect(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")).status).toBe("registered");
    await runProvisioner("create", configured, { ...options, env: {} });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/register"))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/invites"))).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")).status).toBe("ready");
  });

  it("rejects invalid user inputs before creating an org", async () => {
    const { request, options, fetch } = await fixture();
    await expect(runProvisioner("create", { ...request, inputs: { ...request.inputs, user_emails: [""] } }, options))
      .rejects.toThrow("user_emails");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("explicitly confirms when cleanup has no organization to deactivate", async () => {
    const { request, options } = await fixture();
    expect(await runProvisioner("deactivate", request, options)).toEqual({ deactivated: true, not_created: true });
    expect(options.fetch).not.toHaveBeenCalled();
  });
  it("inspects local metadata without credentials or network calls and verifies without changing lifecycle state", async () => {
    const { request, options, fetch, dir } = await fixture();
    const outputs = await runProvisioner("create", request, options);
    const before = await readFile(join(dir, "receipt.json"), "utf8");
    fetch.mockClear();
    const local = await runProvisioner("inspect", { ...request, outputs }, { ...options, env: {} });
    expect(local).toMatchObject({ id: organizationId, name: "example_com", environment: "prod", verified: false, remote_state: null });
    expect(JSON.stringify(local)).not.toContain("private-pat");
    expect(fetch).not.toHaveBeenCalled();
    const remote = await runProvisioner("inspect", { ...request, outputs, verify: true }, options);
    expect(remote).toMatchObject({ verified: true, remote_state: "active" });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/kauth/api/v1/client-authentication", "/kauth/api/v1/client-authentication/org-token-exchange", "/v3/organizations/state/history",
    ]);
    expect(await readFile(join(dir, "receipt.json"), "utf8")).toBe(before);
    expect(await readFile(outputs.pat_file, "utf8")).toBe("private-pat\n");
  });

  it("inspects incomplete and archived records without recovering or modifying receipts", async () => {
    const { request, options, dir, fetch } = await fixture();
    const absent = await runProvisioner("inspect", request, { ...options, env: {} });
    expect(absent.id).toBeNull();
    expect(absent.verification_error).toEqual({ code: "missing_resource_id" });
    const missing = await runProvisioner("inspect", { ...request, verify: true }, { ...options, env: {} });
    expect(missing.verification_error).toEqual({ code: "missing_resource_id" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(readFile(join(dir, "receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await runProvisioner("create", request, options);
    const before = await readFile(join(dir, "receipt.json"), "utf8");
    const archived = await runProvisioner("inspect", { ...request, archived: true, outputs: { organization_id: "old-organization", organization_name: "old-name" } }, { ...options, env: {} });
    expect(archived).toMatchObject({ id: "old-organization", name: "old-name", verified: false });
    expect(await readFile(join(dir, "receipt.json"), "utf8")).toBe(before);
    await expect(runProvisioner("inspect", { ...request, outputs: { organization_id: "wrong-id" } }, options)).rejects.toThrow("ownership receipt");
  });
  it.each([
    ["/client-authentication", "authentication", 401],
    ["/org-token-exchange", "token_exchange", 403],
    ["/history", "state_lookup", 404],
  ])("returns the failed verification stage and HTTP status for %s without response secrets", async (suffix, phase, status) => {
    const { request, options, fetch, dir } = await fixture();
    const outputs = await runProvisioner("create", request, options);
    const before = await readFile(join(dir, "receipt.json"), "utf8");
    const failingFetch = vi.fn(async (url: string, init: { body?: string; method: string }) =>
      url.endsWith(suffix) ? new Response("SHOULD-NEVER-BE-PRINTED", { status }) : fetch(url, init));
    const result = await runProvisioner("inspect", { ...request, outputs, verify: true }, { ...options, fetch: failingFetch });
    expect(result).toMatchObject({ id: organizationId, verified: false, remote_state: null,
      verification_error: { code: "http_error", phase, status } });
    expect(JSON.stringify(result)).not.toContain("SHOULD-NEVER-BE-PRINTED");
    expect(await readFile(join(dir, "receipt.json"), "utf8")).toBe(before);
  });

  it("distinguishes missing credentials, connection failure and malformed responses", async () => {
    const { request, options } = await fixture();
    const inspection = { ...request, outputs: { organization_id: organizationId }, verify: true };
    const missing = await runProvisioner("inspect", inspection, { ...options, env: {} });
    expect(missing.verification_error).toEqual({ code: "missing_credentials", phase: "authentication" });
    expect(options.fetch).not.toHaveBeenCalled();
    const failed = await runProvisioner("inspect", inspection, { ...options,
      fetch: async () => { throw new Error("SHOULD-NEVER-BE-PRINTED"); } });
    expect(failed.verification_error).toEqual({ code: "transport_error", phase: "authentication" });
    const malformed = await runProvisioner("inspect", inspection, { ...options,
      fetch: async () => new Response("SHOULD-NEVER-BE-PRINTED") });
    expect(malformed.verification_error).toEqual({ code: "invalid_response", phase: "authentication" });
    expect(JSON.stringify([missing, failed, malformed])).not.toContain("SHOULD-NEVER-BE-PRINTED");
  });
  it("registers once, returns a PAT file, and verifies REST deactivation", async () => {
    const { request, options, fetch, dir } = await fixture();
    const outputs = await runProvisioner("create", request, options);
    expect(outputs.organization_id).toBe(organizationId);
    expect(JSON.stringify(outputs)).not.toContain("private-pat");
    expect((await stat(outputs.pat_file)).mode & 0o777).toBe(0o600);
    expect(await readFile(outputs.pat_file, "utf8")).toBe("private-pat\n");
    expect(await runProvisioner("create", request, options)).toEqual(outputs);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/register"))).toHaveLength(1);
    expect(await runProvisioner("deactivate", { ...request, outputs }, options)).toEqual({ deactivated: true, organization_id: organizationId, retention_days: 1 });
    expect(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")).status).toBe("inactive");
    expect(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")).retention_days).toBe(1);
    await expect(readFile(outputs.pat_file)).rejects.toMatchObject({ code: "ENOENT" });
    const calls = fetch.mock.calls.length;
    expect(await runProvisioner("deactivate", { ...request, outputs }, options)).toMatchObject({ deactivated: true, retention_days: 1 });
    expect(fetch.mock.calls).toHaveLength(calls);
  });

  it("refuses mismatched workspace or organization ownership", async () => {
    const { request, options, fetch } = await fixture();
    await runProvisioner("create", request, options);
    await expect(runProvisioner("deactivate", { ...request, workspace: { ...request.workspace, id: "b".repeat(32) } }, options)).rejects.toThrow("ownership");
    await expect(runProvisioner("deactivate", { ...request, outputs: { organization_id: "different" } }, options)).rejects.toThrow("ownership");
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/org-token-exchange"))).toBe(false);
  });

  it("retains uncertain registrations and never blindly repeats their POST", async () => {
    const { request, options, dir } = await fixture();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/register")) throw new Error("network interrupted");
      return new Response(JSON.stringify({ token: { access_token: "token" } }));
    });
    await expect(runProvisioner("create", request, { ...options, fetch })).rejects.toThrow("uncertain");
    expect(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")).status).toBe("registering");
    await expect(runProvisioner("create", request, { ...options, fetch })).rejects.toThrow("uncertain");
    await expect(runProvisioner("deactivate", request, { ...options, fetch })).rejects.toThrow("uncertain");
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/register"))).toHaveLength(1);
  });

  it("does not return response secrets in failures", async () => {
    const { request, options } = await fixture();
    const fetch = vi.fn(async () => new Response('{"secret":"do-not-log"}', { status: 403 }));
    await expect(runProvisioner("create", request, { ...options, fetch })).rejects.toThrow("HTTP 403");
  });
});
