import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceSourceKind } from "./workspace-state.js";

const defaultExecFileAsync = promisify(execFile);

export interface RunGitHubLifecycleInput {
  repo: string;
  source_kind: WorkspaceSourceKind;
  source_number: number;
}

export interface GitHubLifecycleDependencies {
  execFileAsync?: typeof defaultExecFileAsync;
}

interface ProjectStatusTarget {
  item_id: string;
  project_id: string;
  field_id: string;
  option_id: string;
}

const ISSUE_PROJECT_ITEMS_QUERY = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    issue(number:$number) {
      projectItems(first:20) {
        nodes {
          id
          project {
            id
            fields(first:50) {
              nodes {
                __typename
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const UPDATE_PROJECT_STATUS_MUTATION = `
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }
  ) {
    projectV2Item {
      id
    }
  }
}
`;

function formatError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.length > 0
  ) {
    return error.stderr.trim();
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split("/");
  if (
    owner === undefined ||
    name === undefined ||
    owner.length === 0 ||
    name.length === 0 ||
    rest.length > 0
  ) {
    throw new Error(`Invalid GitHub repo identifier: ${repo}`);
  }

  return { owner, name };
}

async function runGh(
  args: string[],
  execFileAsync: typeof defaultExecFileAsync,
): Promise<string> {
  const { stdout } = await execFileAsync("gh", args);
  return stdout;
}

async function assignIssueToCurrentUser(
  repo: string,
  issueNumber: number,
  execFileAsync: typeof defaultExecFileAsync,
): Promise<void> {
  await runGh(
    [
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-assignee",
      "@me",
    ],
    execFileAsync,
  );
}

async function assignPullRequestToCurrentUser(
  repo: string,
  prNumber: number,
  execFileAsync: typeof defaultExecFileAsync,
): Promise<void> {
  await runGh(
    [
      "pr",
      "edit",
      String(prNumber),
      "--repo",
      repo,
      "--add-assignee",
      "@me",
    ],
    execFileAsync,
  );
}

function findProjectStatusTargets(parsed: unknown): ProjectStatusTarget[] {
  const nodes =
    typeof parsed === "object" &&
    parsed !== null &&
    "data" in parsed &&
    typeof parsed.data === "object" &&
    parsed.data !== null &&
    "repository" in parsed.data &&
    typeof parsed.data.repository === "object" &&
    parsed.data.repository !== null &&
    "issue" in parsed.data.repository &&
    typeof parsed.data.repository.issue === "object" &&
    parsed.data.repository.issue !== null &&
    "projectItems" in parsed.data.repository.issue &&
    typeof parsed.data.repository.issue.projectItems === "object" &&
    parsed.data.repository.issue.projectItems !== null &&
    "nodes" in parsed.data.repository.issue.projectItems &&
    Array.isArray(parsed.data.repository.issue.projectItems.nodes)
      ? parsed.data.repository.issue.projectItems.nodes
      : [];

  const targets: ProjectStatusTarget[] = [];

  for (const node of nodes) {
    if (typeof node !== "object" || node === null) {
      continue;
    }

    const itemId =
      "id" in node && typeof node.id === "string" ? node.id : undefined;
    const project =
      "project" in node && typeof node.project === "object" && node.project !== null
        ? node.project
        : null;

    const projectId =
      project !== null && "id" in project && typeof project.id === "string"
        ? project.id
        : undefined;
    const fields =
      project !== null &&
      "fields" in project &&
      typeof project.fields === "object" &&
      project.fields !== null &&
      "nodes" in project.fields &&
      Array.isArray(project.fields.nodes)
        ? project.fields.nodes
        : [];

    if (itemId === undefined || projectId === undefined) {
      continue;
    }

    for (const field of fields) {
      if (
        typeof field !== "object" ||
        field === null ||
        field.__typename !== "ProjectV2SingleSelectField"
      ) {
        continue;
      }

      const fieldName =
        "name" in field && typeof field.name === "string" ? field.name : "";
      if (fieldName.trim().toLowerCase() !== "status") {
        continue;
      }

      const fieldId =
        "id" in field && typeof field.id === "string" ? field.id : undefined;
      const options =
        "options" in field && Array.isArray(field.options) ? field.options : [];

      const inProgressOption = options.find(
        (option: unknown) =>
          typeof option === "object" &&
          option !== null &&
          "name" in option &&
          typeof option.name === "string" &&
          option.name.trim().toLowerCase() === "in progress" &&
          "id" in option &&
          typeof option.id === "string",
      ) as { id: string; name: string } | undefined;

      if (fieldId !== undefined && inProgressOption !== undefined) {
        targets.push({
          item_id: itemId,
          project_id: projectId,
          field_id: fieldId,
          option_id: inProgressOption.id,
        });
      }
    }
  }

  return targets;
}

async function markIssueProjectItemsInProgress(
  repo: string,
  issueNumber: number,
  execFileAsync: typeof defaultExecFileAsync,
): Promise<number> {
  const { owner, name } = parseRepo(repo);
  const queryOutput = await runGh(
    [
      "api",
      "graphql",
      "-f",
      `query=${ISSUE_PROJECT_ITEMS_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-F",
      `number=${issueNumber}`,
    ],
    execFileAsync,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(queryOutput);
  } catch (error: unknown) {
    throw new Error(
      `Failed to parse project metadata for issue #${issueNumber} in ${repo}: ${formatError(error)}`,
    );
  }

  const targets = findProjectStatusTargets(parsed);
  for (const target of targets) {
    await runGh(
      [
        "api",
        "graphql",
        "-f",
        `query=${UPDATE_PROJECT_STATUS_MUTATION}`,
        "-F",
        `projectId=${target.project_id}`,
        "-F",
        `itemId=${target.item_id}`,
        "-F",
        `fieldId=${target.field_id}`,
        "-F",
        `optionId=${target.option_id}`,
      ],
      execFileAsync,
    );
  }

  return targets.length;
}

export async function runGitHubLifecycle(
  input: RunGitHubLifecycleInput,
  dependencies: GitHubLifecycleDependencies = {},
): Promise<string[]> {
  const execFileAsync = dependencies.execFileAsync ?? defaultExecFileAsync;
  const warnings: string[] = [];

  if (input.source_kind === "issue") {
    try {
      await assignIssueToCurrentUser(input.repo, input.source_number, execFileAsync);
    } catch (error: unknown) {
      warnings.push(
        `Failed to assign GitHub issue #${input.source_number} in ${input.repo}: ${formatError(error)}`,
      );
    }

    try {
      await markIssueProjectItemsInProgress(
        input.repo,
        input.source_number,
        execFileAsync,
      );
    } catch (error: unknown) {
      warnings.push(
        `Failed to set GitHub issue #${input.source_number} project status to In Progress in ${input.repo}: ${formatError(error)}`,
      );
    }

    return warnings;
  }

  try {
    await assignPullRequestToCurrentUser(
      input.repo,
      input.source_number,
      execFileAsync,
    );
  } catch (error: unknown) {
    warnings.push(
      `Failed to assign GitHub PR #${input.source_number} in ${input.repo}: ${formatError(error)}`,
    );
  }

  return warnings;
}
