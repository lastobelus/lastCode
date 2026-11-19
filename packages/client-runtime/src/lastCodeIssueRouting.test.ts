import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveIssueLinkTarget } from "./issueLinks.ts";
import { holdIssuePages, issueFilterScopes } from "./issueList.ts";
import type { EnvironmentProject } from "./state/models.ts";

const environmentId = EnvironmentId.make("env");
const github = IssueTrackerKind.make("github");
const fork: EnvironmentProject = {
  id: ProjectId.make("fork"),
  environmentId,
  title: "Fork",
  workspaceRoot: "/fork",
  repositoryIdentity: {
    canonicalKey: "github.com/upstream/repo",
    provider: SourceControlProviderKind.make("github"),
    locator: {
      source: "git-remote",
      remoteName: "upstream",
      remoteUrl: "https://github.com/upstream/repo.git",
    },
    displayName: "upstream/repo",
    origin: { canonicalKey: "github.com/fork/repo" },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
};

describe("fork issue navigation", () => {
  it("opens a fork issue in its own project ahead of other GitHub projects", () => {
    const other: EnvironmentProject = {
      ...fork,
      id: ProjectId.make("other"),
      repositoryIdentity: {
        canonicalKey: "github.com/other/repo",
        provider: SourceControlProviderKind.make("github"),
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/other/repo.git",
        },
        displayName: "other/repo",
      },
    };
    expect(
      resolveIssueLinkTarget({
        url: "https://github.com/fork/repo/issues/7",
        projects: [other, fork],
      })?.ref,
    ).toMatchObject({ projectId: fork.id, scope: "fork/repo", key: "7" });
  });

  it("only requests filter candidates for the fork when the server lists its scope", () => {
    const scope = { projectId: fork.id, tracker: github, host: "github.com", scope: "fork/repo" };
    const held = holdIssuePages(
      [
        [
          environmentId,
          {
            viewers: {},
            trackers: [
              {
                tracker: github,
                host: "github.com",
                projectCount: 1,
                capabilities: {
                  create: true,
                  edit: true,
                  comment: true,
                  labels: true,
                  assignees: true,
                  reactions: true,
                  templates: true,
                  linkedPullRequests: true,
                  events: true,
                  search: true,
                },
                configured: true,
                detail: null,
              },
            ],
            entries: [],
            errors: [],
            nextCursors: {},
            scopes: [scope],
          },
        ],
      ],
      new Map(),
    );
    expect(issueFilterScopes(held, [fork])).toEqual([{ environmentId, input: scope }]);
  });
});
