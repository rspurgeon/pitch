#!/usr/bin/env node
// Konnect-specific implementation of Pitch's generic JSON provisioner protocol.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const bases = { prod: "https://global.api.konghq.com", dev: "https://global.api.konghq.tech" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function writePrivate(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try { await file.chmod(0o600); await file.writeFile(value); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("Invalid provisioner receipt JSON");
    throw error;
  }
}

export async function runProvisioner(action, request, { fetch: requestFetch = fetch, env = process.env } = {}) {
  if (!["create", "deactivate", "inspect"].includes(action)) throw new Error("Expected create, deactivate or inspect");
  const { workspace, inputs, resource_dir: directory } = request;
  if (request.version !== 1 || !/^[a-f0-9]{32}$/.test(workspace?.id ?? "") || !directory || !inputs) {
    throw new Error("Invalid provisioner request");
  }
  const base = Object.hasOwn(bases, inputs.environment) ? bases[inputs.environment] : undefined;
  if (!base || typeof inputs.organization_name !== "string" || !inputs.organization_name.trim() ||
      typeof inputs.owner_email !== "string" || !inputs.owner_email.includes("@")) {
    throw new Error("environment (prod/dev), organization_name and owner_email are required");
  }
  const userEmails = inputs.user_emails ?? [];
  if (action === "create" && (!Array.isArray(userEmails) || userEmails.some((email) =>
    typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
    throw new Error("user_emails must be an array of email addresses");
  }
  if (action !== "inspect") await mkdir(directory, { recursive: true, mode: 0o700 });
  const receiptPath = join(directory, "receipt.json");
  const responsePath = join(directory, "registration.json");
  const patFile = join(directory, "pat");
  let receipt = action === "inspect" && request.archived ? undefined : await readJson(receiptPath);
  const identity = { workspace_id: workspace.id, repo: workspace.repo, environment: inputs.environment,
    organization_name: inputs.organization_name, owner_email: inputs.owner_email };
  if (receipt && Object.entries(identity).some(([key, value]) => receipt[key] !== value)) {
    throw new Error("Receipt ownership does not match this workspace and provisioner input");
  }
  if (action === "inspect") {
    if (receipt?.organization_id && request.outputs?.organization_id && receipt.organization_id !== request.outputs.organization_id) {
      throw new Error("Organization ID does not match its ownership receipt");
    }
    const inspection = {
      id: receipt?.organization_id ?? request.outputs?.organization_id ?? null,
      name: receipt?.organization_name ?? request.outputs?.organization_name ?? inputs.organization_name,
      environment: inputs.environment,
      created_at: receipt?.created_at ?? request.created_at ?? null,
      deactivated_at: receipt?.deactivated_at ?? null,
      verified: false,
      remote_state: null,
      reprovisionable: false,
    };
    // Expose local blockers before Pitch attempts to load service credentials.
    if (!uuid.test(inspection.id ?? "")) {
      inspection.verification_error = { code: "missing_resource_id" };
      return inspection;
    }
    if (request.verify) {
      let phase = "authentication";
      try {
        const token = await authenticate();
        phase = "token_exchange";
        const exchange = await api("POST", "/kauth/api/v1/client-authentication/org-token-exchange", token,
          { organization_id: inspection.id });
        if (!exchange.access_token) throw new ApiError("Organization token exchange returned no access token", "invalid_response");
        phase = "state_lookup";
        const history = await api("GET", "/v3/organizations/state/history", exchange.access_token);
        if (typeof history.data?.[0]?.state !== "string" || !history.data[0].state) throw new ApiError("Organization state unavailable", "invalid_response");
        inspection.remote_state = history.data[0].state;
        inspection.verified = true;
        inspection.reprovisionable = inspection.remote_state === "inactive";
      } catch (error) {
        inspection.verification_error = error instanceof ApiError
          ? { code: error.code, phase, ...(error.status === undefined ? {} : { status: error.status }) }
          : { code: "verification_failed", phase };
      }
    }
    return inspection;
  }
  const saveReceipt = async () => writePrivate(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const outputs = () => ({ organization_id: receipt.organization_id, user_id: receipt.user_id,
    organization_name: receipt.organization_name, environment: receipt.environment, pat_file: patFile });
  async function finishCreation(response) {
    if (typeof response?.konnect_token !== "string" || !response.konnect_token || !receipt.user_id) {
      throw new Error("Registration did not return usable credentials; deactivate using the receipt");
    }
    await writePrivate(patFile, `${response.konnect_token}\n`);
    if (userEmails.length) {
      // Query membership on every attempt, including after an uncertain invite.
      // Invited users are usable for assignments even before their first login.
      const users = new Map();
      let complete = false;
      for (let page = 1; page <= 10000; page++) {
        const result = await api("GET", `/v3/users?page[size]=100&page[number]=${page}`, response.konnect_token);
        if (!Array.isArray(result.data) || result.data.some((user) =>
          typeof user.email !== "string" || typeof user.id !== "string")) {
          throw new ApiError("Organization users lookup returned invalid data", "invalid_response");
        }
        for (const user of result.data) users.set(user.email.toLowerCase(), user.id);
        if (result.data.length < 100 || result.meta?.page?.total <= page * 100) { complete = true; break; }
      }
      if (!complete) throw new Error("Organization users pagination exceeded safety limit");
      receipt.status = "registered";
      receipt.invited_users ??= [];
      await saveReceipt();
      for (const email of new Set(userEmails.map((email) => email.toLowerCase()))) {
        let userId = users.get(email);
        if (!userId) {
          const invitation = await api("POST", "/v3/invites", response.konnect_token, { email }, 201);
          if (typeof invitation.user_id !== "string" || !invitation.user_id) {
            throw new ApiError("Invitation returned no user ID", "invalid_response");
          }
          userId = invitation.user_id;
        }
        if (!receipt.invited_users.some((user) => user.email === email)) {
          receipt.invited_users.push({ email, user_id: userId });
          await saveReceipt();
        }
      }
    }
    receipt.status = "ready";
    await saveReceipt();
    return outputs();
  }
  // Recover an acknowledged registration if the process stopped between saving the
  // raw response and its ownership receipt. Never repeat the registration POST.
  if (receipt?.status === "registering") {
    const response = await readJson(responsePath);
    if (uuid.test(response?.organization_id ?? "")) {
      receipt.organization_id = response.organization_id;
      receipt.user_id = response.user_id;
      receipt.status = "registered";
      await saveReceipt();
    }
  }
  if (action === "create" && ["registered", "ready"].includes(receipt?.status)) {
    const response = await readJson(responsePath);
    return finishCreation(response);
  }
  if (receipt?.status === "registering") {
    throw new Error("Registration outcome is uncertain; reconcile the request with the service team before retrying");
  }
  if (action === "create" && receipt?.status === "inactive") throw new Error("Organization already deactivated");
  if (action === "deactivate" && (!receipt || ["planned", "inactive"].includes(receipt.status))) {
    if (!receipt && request.outputs?.organization_id) throw new Error("Missing ownership receipt; refusing deactivation");
    // No registering receipt means this helper never sent the creation request.
    if (receipt?.status === "inactive") {
      await rm(patFile, { force: true });
      await rm(responsePath, { force: true });
    }
    return receipt?.status === "inactive"
      ? { deactivated: true, ...(Number.isInteger(receipt.retention_days) ? { retention_days: receipt.retention_days } : {}) }
      : { deactivated: true, not_created: true };
  }
  async function api(method, path, token, body, expected = 200) {
    let response;
    try {
      response = await requestFetch(`${base}${path}`, { method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000), redirect: "error" });
    } catch { throw new ApiError(`Konnect ${method} ${path}: transport failed (outcome may be uncertain)`, "transport_error"); }
    if (response.status !== expected) throw new ApiError(`Konnect ${method} ${path}: HTTP ${response.status}`, "http_error", response.status);
    try { return await response.json(); }
    catch { throw new ApiError(`Konnect ${method} ${path}: invalid JSON response`, "invalid_response"); }
  }
  async function authenticate() {
    const secret = env[inputs.environment === "prod" ? "KAUTH_CLIENT_SECRET_PROD" : "KAUTH_CLIENT_SECRET_DEV"];
    if (!env.KAUTH_CLIENT_ID || !secret) throw new ApiError("Missing KAuth service credentials", "missing_credentials");
    const auth = await api("POST", "/kauth/api/v1/client-authentication", undefined,
      { client_id: env.KAUTH_CLIENT_ID, client_secret: secret });
    const token = auth?.token?.access_token;
    if (!token) throw new ApiError("Client authentication returned no access token", "invalid_response");
    return token;
  }
  const token = await authenticate();
  if (action === "create") {
    receipt = { ...identity, status: "planned", created_at: new Date().toISOString() };
    await saveReceipt();
    receipt.status = "registering";
    await saveReceipt();
    const response = await api("POST", "/v1/internal/organizations/register", token,
      { organization_name: inputs.organization_name, user_full_name: inputs.owner_email.split("@")[0], email: inputs.owner_email }, 201);
    await writePrivate(responsePath, `${JSON.stringify(response)}\n`);
    if (!uuid.test(response.organization_id ?? "")) throw new Error("Registration returned no valid organization ID");
    receipt.organization_id = response.organization_id;
    receipt.user_id = response.user_id;
    receipt.status = "registered";
    await saveReceipt();
    if (!response.user_id || typeof response.konnect_token !== "string" || !response.konnect_token) {
      throw new Error("Registration returned incomplete credentials; ownership saved for cleanup");
    }
    return finishCreation(response);
  }
  if (!uuid.test(receipt?.organization_id ?? "") ||
      (request.outputs?.organization_id && request.outputs.organization_id !== receipt.organization_id)) {
    throw new Error("Refusing deactivation without matching organization ownership");
  }
  const exchange = await api("POST", "/kauth/api/v1/client-authentication/org-token-exchange", token,
    { organization_id: receipt.organization_id });
  const orgToken = exchange.access_token;
  if (!orgToken) throw new Error("Organization token exchange returned no access token");
  const history = await api("GET", "/v3/organizations/state/history", orgToken);
  if (history.data?.[0]?.state !== "inactive") {
    await api("PATCH", `/v3/organizations/${receipt.organization_id}/deletion-config`, orgToken,
      { retention_period_days: 1 });
    // Persist the applied policy before deactivation so retries retain it.
    receipt.retention_days = 1;
    await saveReceipt();
    await api("POST", "/v3/organizations/state", orgToken,
      { state: "inactive", reason: `Pitch workspace ${workspace.id} deleted` });
  }
  const final = await api("GET", "/v3/organizations/state/history", orgToken);
  if (final.data?.[0]?.state !== "inactive") throw new Error("Organization deactivation not confirmed");
  receipt.status = "inactive";
  receipt.deactivated_at = new Date().toISOString();
  await saveReceipt();
  await rm(patFile, { force: true });
  await rm(responsePath, { force: true });
  return { deactivated: true, organization_id: receipt.organization_id,
    ...(Number.isInteger(receipt.retention_days) ? { retention_days: receipt.retention_days } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    let request;
    try { request = JSON.parse(input); }
    catch { throw new Error("Invalid provisioner request JSON"); }
    const result = await runProvisioner(process.argv[2], request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Messages above contain operation/status only, never response bodies or credentials.
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
