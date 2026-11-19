import { describe, expect, it } from "@effect/vitest";
import { IssueTrackerKind, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import type { OrchestrationProjectShell, RepositoryIdentity } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";
import type { IssueTrackerApi } from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";
import * as LastCodeIssueService from "./LastCodeIssueService.ts";

const projectId = ProjectId.make("project");
const github = IssueTrackerKind.make("github");
const projectIdentity: RepositoryIdentity = {
  canonicalKey: "github.com/upstream/repo",
  locator: {
    source: "git-remote",
    remoteName: "upstream",
    remoteUrl: "https://github.com/upstream/repo.git",
  },
  provider: SourceControlProviderKind.make("github"),
  owner: "upstream",
  name: "repo",
  displayName: "upstream/repo",
  origin: {
    canonicalKey: "github.com/fork/repo",
    remoteUrl: "git@github.com-work:fork/Repo.git",
    displayName: "fork/Repo",
  },
};

function tracker(overrides: Partial<IssueTrackerApi> = {}): IssueTrackerApi {
  return {
    kind: github,
    capabilities: {
      create: true,
      edit: false,
      comment: true,
      labels: false,
      assignees: false,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: false,
    },
    getViewer: () => Effect.succeed("tester"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: () => Effect.die("Unexpected issue read"),
    getComments: () => Effect.die("Unexpected comment read"),
    ...overrides,
  };
}

function makeService(identity: RepositoryIdentity, api = tracker()) {
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "Repository",
    workspaceRoot: "/repo",
    repositoryIdentity: identity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
  return IssueService.IssueService.pipe(
    Effect.provide(
      LastCodeIssueService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
              list: Effect.succeed(new Map()),
            }),
            Layer.succeed(
              IssueTrackerRegistry.IssueTrackerRegistry,
              IssueTrackerRegistry.fromTrackers([api]),
            ),
            Layer.mock(ProjectService.ProjectService)({
              getShell: () => Effect.succeed(Option.some(project)),
              listShells: () => Effect.succeed([project]),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          ),
        ),
      ),
    ),
  );
}

const createInput = { title: "A fixture issue", body: "", labels: [], assignees: [] };

describe("LastCode issue repositories", () => {
  it.effect("uses the fork for project scope, lists, and writable issue URLs", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      const service = yield* makeService(
        projectIdentity,
        tracker({
          listIssues: (input) =>
            Effect.sync(() => {
              listed.push(input.scope);
              return { items: [], nextCursor: null };
            }),
        }),
      );
      expect(yield* service.projectScope(projectId)).toEqual({
        projectId,
        tracker: github,
        host: "github.com",
        scope: "fork/Repo",
      });
      yield* service.list({ projectId, state: "open" });
      expect(listed).toEqual(["fork/Repo"]);
      expect(
        yield* service.resolveUrl("https://github.com/fork/Repo/issues/1", projectId),
      ).toMatchObject({ scope: "fork/Repo", writable: true });

      const parent = yield* service.resolveUrl(
        "https://github.com/upstream/repo/issues/1",
        projectId,
      );
      expect(parent).toMatchObject({ scope: "upstream/repo", writable: false });
      for (const write of [
        service.create({ ...parent, ...createInput }),
        service.comment({ ...parent, body: "A fixture comment" }),
        service.setState({ ...parent, state: "closed" }),
      ]) {
        expect(yield* Effect.flip(write.pipe(Effect.asVoid))).toMatchObject({
          reason: "read-only",
        });
      }
    }),
  );

  it.effect("returns the fork's error when its issue tracker is disabled", () =>
    Effect.gen(function* () {
      const attempted: string[] = [];
      const service = yield* makeService(
        projectIdentity,
        tracker({
          create: (input) =>
            Effect.sync(() => attempted.push(input.scope)).pipe(
              Effect.andThen(
                Effect.fail(
                  new IssueTrackerError({
                    tracker: github,
                    operation: "create",
                    reason: "failed",
                    detail: "Issues are disabled on this repository.",
                  }),
                ),
              ),
            ),
        }),
      );
      const target = yield* service.projectScope(projectId);
      expect(yield* Effect.flip(service.create({ ...target, ...createInput }))).toMatchObject({
        detail: "Issues are disabled on this repository.",
      });
      expect(attempted).toEqual(["fork/Repo"]);
    }),
  );

  it.effect("keeps the canonical target for an origin with no fork identity", () =>
    Effect.gen(function* () {
      const { origin: _, ...identity } = projectIdentity;
      const service = yield* makeService({
        ...identity,
        locator: { ...identity.locator, remoteName: "origin" },
      });
      expect(yield* service.projectScope(projectId)).toMatchObject({ scope: "upstream/repo" });
    }),
  );

  it.effect("uses a different host's tracker and scope when origin is on that host", () =>
    Effect.gen(function* () {
      const gitlab = IssueTrackerKind.make("gitlab");
      const service = yield* makeService(
        { ...projectIdentity, origin: { canonicalKey: "gitlab.com/fork/mirror" } },
        tracker({ kind: gitlab }),
      );
      expect(yield* service.projectScope(projectId)).toMatchObject({
        tracker: gitlab,
        host: "gitlab.com",
        scope: "fork/mirror",
      });
    }),
  );
});
