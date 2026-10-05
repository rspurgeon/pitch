# Workspace environments and provisioners

Repository `env` and `env_from_files` bindings apply to both terminal panes and
agents. The selected context overrides repository bindings by variable name,
including when a file replaces a literal or a literal replaces a file. Agent
settings remain available for agent-specific configuration; shared repository
and context bindings take precedence over them.

```yaml
repos:
  example/project:
    main_worktree: ~/dev/project
    default_context: local
    env:
      OUTPUT_FORMAT: json
    contexts:
      local:
        env:
          API_URL: https://example.test
        env_from_files:
          API_TOKEN: ~/.tokens/example
```

Pitch writes an owner-only `environment.sh` under
`~/.pitch/resources/<workspace-id>/`. It exports literal values and reads
credentials from their files when sourced. It removes variables managed by the
previous environment and excludes credentials configured for provisioners.
Provisioner credentials belong only in provisioner configuration, never in agent
or shared environment bindings. Files are loaded before a refresh changes any
variables, so an unreadable credential file fails without clearing the old values.

```sh
source "$(pitch refresh my-workspace)"
pitch show my-workspace
```

Alternatively, source `examples/pitch-env-refresh.zsh` from your shell setup and
run `pitch-env-refresh`. A shell opened outside a workspace can use
`pitch-env-refresh my-workspace`. Existing agents must be restarted to receive
environment changes. Refresh does not renew tokens or create resources.

Environment files and provisioning currently support host execution environments.
VM execution retains its existing agent environment handling.

## Provisioner commands

Provisioners are named command definitions. A context selects them by name and
supplies inputs and private credentials. A context without `provisioners` creates
no external resources. Different repositories can map the same provisioner's
outputs into different variables and configuration files.

```yaml
provisioners:
  example_service:
    create: [node, /path/to/provisioner.mjs, create]
    delete: [node, /path/to/provisioner.mjs, deactivate]
    timeout_ms: 180000
    env_from_files:
      SERVICE_CLIENT_ID: ~/.tokens/service-client-id
repos:
  example/project:
    main_worktree: ~/dev/project
    default_context: ephemeral
    contexts:
      ephemeral:
        provisioners:
          example_service:
            inputs:
              name: "{{ workspace.name }}"
            env_from_files:
              SERVICE_CLIENT_SECRET: ~/.tokens/service-client-secret
        generated_files:
          application:
            path: "{{ workspace.resource_dir }}/files/application.yaml"
            contents:
              output: json
              instance: "{{ provisioners.example_service.outputs.name }}"
        env:
          APPLICATION_CONFIG: "{{ files.application }}"
        env_from_files:
          APPLICATION_TOKEN: "{{ provisioners.example_service.outputs.token_file }}"
```

Generated files are YAML, mode 0600, and must be under
`{{ workspace.resource_dir }}/files/`. Templates support scalar references to
`workspace`, `provisioners.<name>.outputs`, and `files.<name>`. The `env_key` filter
uppercases a value and replaces hyphens and dots with underscores. Variable names are
validated after rendering. Unknown references fail instead of producing empty
strings. Provisioners run in declaration order and clean up in reverse order.

Commands receive a JSON object on stdin:

```json
{
  "version": 1,
  "workspace": {"id": "stable-id", "name": "my-workspace", "repo": "owner/repo"},
  "resource_dir": "/private/directory/for/this/provisioner",
  "inputs": {"name": "my-workspace"},
  "outputs": {"name": "previously-returned-output"}
}
```

`outputs` is absent on the initial create. Create prints one JSON object of
outputs to stdout. Return credential **file paths**, not credential values.
Delete receives the saved inputs and outputs and must return
`{"deactivated":true}` only after verifying cleanup. Commands must keep their own
ownership receipts inside `resource_dir` and support retries, including deletion
after partially completed creation. Do not use resource names as proof of
ownership. Never put secrets in command arguments or diagnostics.

To enable history pruning, delete also returns `retention_days`: the remote
retention period actually applied. Return `0` if remote deletion is immediate.
If creation definitively never occurred, return `not_created: true` instead.
Pitch records this evidence and the cleanup confirmation time. Missing IDs,
failed authentication, and an unreachable service do not prove non-creation.

Pitch saves the selected commands, input configuration, and outputs before
continuing workspace setup. Saved commands and credential file references are
used for cleanup even if the current configuration changes. Updating secret file
contents therefore works; moving those files requires retaining their old paths
until affected resources have been cleaned up.

## Lifecycle and recovery

- Create provisions once. A later setup failure triggers cleanup.
- Close leaves resources active for later use.
- Resume reuses recorded outputs. It never provisions missing resources.
- Delete closes the workspace, deactivates resources, then removes local state
  and the worktree. Failed cleanup stops deletion and retains the receipt.
- `pitch cleanup <provisioner> --workspace <name>` cleans up only that
  provisioner for a closed workspace or an interrupted creation without a
  workspace record. Use `--repo owner/repo` when recovering a workspace outside
  the default repository. Other provisioners remain tracked for later cleanup.
- `pitch refresh <name>` regenerates the workspace environment from current
  configuration and existing outputs, then prints its file path. It does not
  provision resources or change running shells or agents.
- `pitch reprovision <provisioner> --workspace <name>` replaces a resource whose
  inspector confirms it is eligible for replacement. The workspace must be
  closed. Its checkout, branch, name, and saved agent session are retained.
- `pitch show <name>` displays workspace details, including its environment-file
  path when available. Both commands support `--json`.

Switching to another provisioned context requires a new workspace. Switching to
a static context retains the existing managed resources for eventual deletion.
Renaming a workspace retains its resource ID and original provisioned names.
The original name remains reserved for provisioning until those resources are
cleaned up; this prevents two workspaces from sharing an organization by accident.
Completed receipts remain until their local retention expires. A filesystem
lock prevents overlapping lifecycle commands; after a killed process, confirm
it is no longer running before removing the `.lock` directory named in the error.

## Replacing a backend-deactivated organization

A backend can deactivate an organization while Pitch still records the workspace
as active. `pitch list konnect_org --verify` checks remote state but does not
change local ownership records. Refresh and resume never create a replacement.

Run the following from a terminal outside the workspace being closed:

```sh
pitch close aigw-2-2
pitch reprovision konnect_org --workspace aigw-2-2
pitch resume aigw-2-2
```

The Konnect inspector permits replacement only after a successful remote check
reports `inactive`. Active organizations, failed verification, and missing remote
IDs are refused. No force bypass is provided. `.tech` organizations keep their
recorded `dev` environment, organization name, owner, and invited-user inputs.

Reprovision reconciles the old receipt through the recorded cleanup command,
archives that provisioner's old outputs, creates a replacement in a separate
helper directory, and regenerates configuration and environment bindings. Other
provisioners remain unchanged. The command prints the environment-file path;
`--json` returns it under `result`. Resume opens terminals and an agent with the
new credentials. For an external terminal that needs the workspace environment:

```sh
source "$(pitch refresh aigw-2-2)"
kcp aigw-2-2_tech
kongctl get org
```

If replacement fails, rerun the same reprovision command after addressing the
reported problem. A durable operation marker preserves the retirement, creation,
or environment-refresh phase. Refresh, resume, and cleanup refuse pending
reprovision operations. Creation retries reuse the same helper receipt; an
uncertain registration without a saved response still requires reconciliation
with the service team. Do not delete that receipt to force a retry.

Inspectors opt into replacement by returning both `verified: true` and
`reprovisionable: true` during verified inspection. This is a provider-specific
decision, not a generic interpretation of a status string. The Konnect helper
returns it only for remotely inactive organizations. Cleaning up an already
inactive organization does not reset its retention policy; unknown retention
remains unknown in the archived record.

## Local history retention

Pitch prunes expired completed history after successful workspace creation and
deletion. Listing never prunes. To inspect or prune manually:

```sh
pitch prune konnect_org --dry-run
pitch prune konnect_org
pitch prune konnect_org --repo kong/kongctl --json
```

Pruning reads local records only: it never loads service credentials, runs a
provisioner, or contacts Konnect. It removes completed records after the cleanup
confirmation time plus the recorded remote retention and a buffer. Configure
the buffer per provisioner; the default is seven days:

```yaml
provisioners:
  konnect_org:
    create: [node, /path/to/konnect-org.mjs, create]
    delete: [node, /path/to/konnect-org.mjs, deactivate]
    inspect: [node, /path/to/konnect-org.mjs, inspect]
    history_buffer_days: 7
```

For the Konnect helper's one-day retention, local history expires eight days
after confirmed cleanup. Explicitly confirmed never-created resources use the
buffer alone. This is local history expiry, not proof of remote deletion.

Pruning preserves active resources, uncertain outcomes, records with missing
cleanup evidence or retention, and current records referenced by any workspace.
Old archived generations can expire while a newer generation remains active.
Generated assets are removed only after all history in an unowned directory
expires. Provisioning, cleanup, and pruning share the same per-directory lock.
Dry runs create no locks and change no files.

Older records without structured cleanup evidence remain listed as retained,
with the reason shown by `pitch prune`. They require reconciliation; Pitch does
not guess their retention from names, missing IDs, or free-text notes.

All commands support zsh completion. Regenerate an installed completion file,
or reload completion in the current terminal after updating Pitch:

```sh
source <(pitch completion zsh)
```

Completion includes workspace names for `show` and `refresh`, provisioner names
for `list`, `cleanup`, and `prune`, and orphaned workspace names for cleanup's
`--workspace` option. Existing commands also complete configured repositories,
agents, environments, contexts, and available agent or tmux sessions.

## Provisioner inventory

`pitch list` continues to list workspaces. Supply a configured provisioner name
to list resources recorded for that provisioner:

```sh
pitch list konnect_org
pitch list konnect_org --orphaned
pitch list konnect_org --all
pitch list konnect_org --verify
pitch list konnect_org --repo kong/kongctl --json
```

The default lists records not marked cleaned up. Columns show the resource name,
ID, environment, workspace, local lifecycle status, and creation timestamp.
Listing is based on this machine's receipts; it does not discover resources
whose receipts were deleted or created elsewhere. There are no network calls or
credential-file reads during normal listing with the Konnect helper.

`--orphaned` selects records not marked cleaned up that have no matching
workspace record. Matching uses the resource ID and repository, not the name.
Closed and renamed workspaces therefore retain ownership. An interrupted create
without a workspace is included, even if its remote outcome is uncertain.
Workspace age alone does not imply abandonment. Orphan detection refuses to
proceed if workspace records cannot be read reliably.

`--all` includes deactivated records and archived generations retained after a
workspace name is reused. `--orphaned --all` still excludes cleaned-up records.
Unknown names produce an error with available provisioner names; provisioners
removed from configuration can still be listed from retained records.

`--verify` also authenticates using the saved service credential references and
checks each selected resource's current remote state. The remote state is shown
separately from local ownership and lifecycle status. Verification never changes
receipts, repairs local state, or cleans up resources. Failed checks retain the
local row as unverified and cause exit status 1. A missing or inaccessible remote
organization is not assumed to be deleted. Filters continue to use local state.
Warnings use `- Warning:` bullets, identify the resource, and give a next step.
The retained record's path appears on an indented line. Credential-file failures
identify the variable and file without exposing its contents. A missing remote ID is
reported before loading credentials or making a verification request.

Provisioners can supply an optional `inspect` command alongside `create` and
`delete`. Pitch passes the usual JSON request plus `verify` and `archived`
booleans and the recorded `created_at`, when available. Without `verify`, the
command must read only local metadata and need no service credentials. For an
archived generation, it must use the supplied historical outputs instead of the
current generation's receipt. An inspector returns these public fields only:

```json
{
  "name": "example_com",
  "id": "organization-id",
  "environment": "prod",
  "created_at": "2026-09-19T04:18:44.720Z",
  "deactivated_at": null,
  "verified": false,
  "remote_state": null
}
```

On successful verification, return `verified: true` and a nonempty
`remote_state`. Pitch ignores extra fields and never prints raw helper errors,
credentials, inputs, or creation outputs. A configured inspector is used for
existing receipts too; without one, local ownership and lifecycle fields remain
available but provider metadata is unknown. Creation timestamps are unknown for
older records whose original receipt is unavailable.

Failed verification can return `verification_error` with a `code` of
`missing_resource_id`, `missing_credentials`, `transport_error`,
`invalid_response`, or `http_error`. The optional `phase` is `authentication`,
`token_exchange`, or `state_lookup`; `http_error` also requires a numeric HTTP
`status`. Pitch translates these fixed codes into actionable diagnostics and
ignores arbitrary messages. For example:

```json
{
  "verified": false,
  "remote_state": null,
  "verification_error": {
    "code": "http_error",
    "phase": "token_exchange",
    "status": 403
  }
}
```

A local inspection may return `verification_error` to report a blocker such as
a missing ID. Pitch then skips remote verification and reports the blocker.

## Konnect example

`examples/provisioners/konnect-org.mjs` implements the KAuth service registration
flow. It accepts `environment` (`prod` or `dev`), `organization_name`, and
`owner_email`. Supply `KAUTH_CLIENT_ID` and the corresponding
`KAUTH_CLIENT_SECRET_PROD` or `KAUTH_CLIENT_SECRET_DEV` through the provisioner's
`env_from_files`. Auth0 and gRPC credentials are not used.

The optional `user_emails` input is a list of additional users to invite after
registration. Invitations use the new organization's PAT. These users can be
looked up and assigned roles before their first login; invitation does not
activate their accounts. The helper checks existing membership on retries,
skips users already present, and retains the org receipt if an invitation fails.
Calling create again resumes setup without creating another organization.
Environment refresh alone does not run provisioning for existing workspaces.

For example, a context can configure:

```yaml
provisioners:
  konnect_org:
    inputs:
      environment: prod
      organization_name: "{{ workspace.name }}_com"
      owner_email: quality+kongctl-e2e@konghq.com
      user_emails:
        - quality+kongctl-e2e-u1@konghq.com
        - quality+kongctl-e2e-u2@konghq.com
        - quality+kongctl-e2e-u3@konghq.com
```

Configure its inventory handler with:

```yaml
provisioners:
  konnect_org:
    create: [node, /path/to/konnect-org.mjs, create]
    delete: [node, /path/to/konnect-org.mjs, deactivate]
    inspect: [node, /path/to/konnect-org.mjs, inspect]
```

Create returns `organization_id`, `organization_name`, `user_id`, `environment`,
and `pat_file`. Registration creates the owner and its PAT. A repository can map
these outputs into its own profile and token variables; Pitch core has no
Konnect-specific configuration logic.

Cleanup exchanges the service token for an organization token, sets one-day
retention, transitions the organization to `inactive`, and verifies that state
through REST. Permanent deletion is performed later by Konnect. The helper
removes the PAT and saved registration response after confirmed deactivation.
An interrupted registration with no saved response remains uncertain: the
helper refuses another registration or guessed cleanup. Reconcile that receipt
with the service team. Automatic PAT renewal is not implemented; environment
refresh only reloads credentials already present in files.
