import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export interface ReadPullRequestInput {
  repo: string;
  pr_number: number;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  base_ref_name: string;
  head_ref_name: string;
  head_ref_oid: string;
  is_cross_repository: boolean;
  url: string;
}

export class GitHubPullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubPullRequestError";
  }
}

const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  state: z.string().min(1),
  baseRefName: z.string().min(1),
  headRefName: z.string().min(1),
  headRefOid: z.string().min(1),
  isCrossRepository: z.boolean(),
  url: z.string().min(1),
}).strict();

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

export async function readPullRequest(
  input: ReadPullRequestInput,
): Promise<PullRequestInfo> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", [
      "pr",
      "view",
      String(input.pr_number),
      "--repo",
      input.repo,
      "--json",
      [
        "number",
        "title",
        "state",
        "baseRefName",
        "headRefName",
        "headRefOid",
        "isCrossRepository",
        "url",
      ].join(","),
    ]));
  } catch (error: unknown) {
    throw new GitHubPullRequestError(
      `Failed to read PR #${input.pr_number} in ${input.repo}: ${formatError(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error: unknown) {
    throw new GitHubPullRequestError(
      `Failed to parse PR metadata for #${input.pr_number} in ${input.repo}: ${formatError(error)}`,
    );
  }

  const result = PullRequestSchema.safeParse(parsed);
  if (!result.success) {
    throw new GitHubPullRequestError(
      `Invalid PR metadata for #${input.pr_number} in ${input.repo}`,
    );
  }

  return {
    number: result.data.number,
    title: result.data.title,
    state: result.data.state,
    base_ref_name: result.data.baseRefName,
    head_ref_name: result.data.headRefName,
    head_ref_oid: result.data.headRefOid,
    is_cross_repository: result.data.isCrossRepository,
    url: result.data.url,
  };
}
