import { describe, expect, it, vi } from "vitest";
import { runGitHubLifecycle } from "../github-lifecycle.js";

describe("runGitHubLifecycle", () => {
  it("assigns issues and updates matching project items", async () => {
    const execFileAsync = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                projectItems: {
                  nodes: [
                    {
                      id: "ITEM_1",
                      project: {
                        id: "PROJECT_1",
                        fields: {
                          nodes: [
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "FIELD_1",
                              name: "Status",
                              options: [
                                { id: "OPTION_1", name: "Todo" },
                                { id: "OPTION_2", name: "In Progress" },
                              ],
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const warnings = await runGitHubLifecycle(
      {
        repo: "kong/kongctl",
        source_kind: "issue",
        source_number: 42,
      },
      { execFileAsync },
    );

    expect(warnings).toEqual([]);
    expect(execFileAsync).toHaveBeenNthCalledWith(
      1,
      "gh",
      [
        "issue",
        "edit",
        "42",
        "--repo",
        "kong/kongctl",
        "--add-assignee",
        "@me",
      ],
    );
    expect(execFileAsync).toHaveBeenNthCalledWith(
      2,
      "gh",
      expect.arrayContaining([
        "api",
        "graphql",
        "-F",
        "owner=kong",
        "-F",
        "name=kongctl",
        "-F",
        "number=42",
      ]),
    );
    expect(execFileAsync).toHaveBeenNthCalledWith(
      3,
      "gh",
      expect.arrayContaining([
        "api",
        "graphql",
        "-F",
        "projectId=PROJECT_1",
        "-F",
        "itemId=ITEM_1",
        "-F",
        "fieldId=FIELD_1",
        "-F",
        "optionId=OPTION_2",
      ]),
    );
  });

  it("returns warnings instead of failing when GitHub commands error", async () => {
    const execFileAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error("issue assign failed"))
      .mockRejectedValueOnce(new Error("project status failed"));

    const warnings = await runGitHubLifecycle(
      {
        repo: "kong/kongctl",
        source_kind: "issue",
        source_number: 42,
      },
      { execFileAsync },
    );

    expect(warnings).toEqual([
      "Failed to assign GitHub issue #42 in kong/kongctl: issue assign failed",
      "Failed to set GitHub issue #42 project status to In Progress in kong/kongctl: project status failed",
    ]);
  });

  it("assigns PRs without attempting project updates", async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    const warnings = await runGitHubLifecycle(
      {
        repo: "kong/kongctl",
        source_kind: "pr",
        source_number: 123,
      },
      { execFileAsync },
    );

    expect(warnings).toEqual([]);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(execFileAsync).toHaveBeenCalledWith("gh", [
      "pr",
      "edit",
      "123",
      "--repo",
      "kong/kongctl",
      "--add-assignee",
      "@me",
    ]);
  });

  it("skips GitHub lifecycle work for ad hoc workspaces", async () => {
    const execFileAsync = vi.fn();

    const warnings = await runGitHubLifecycle(
      {
        repo: "kong/kongctl",
        source_kind: "adhoc",
        source_number: null,
      },
      { execFileAsync },
    );

    expect(warnings).toEqual([]);
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});
