import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { projectLastCodeProjectThreads } from "./lastcodeProjectThreads";

const parent = makeThreadFixture({
  id: ThreadId.make("parent"),
  createdAt: "2026-01-03T00:00:00.000Z",
});
const child = makeThreadFixture({
  id: ThreadId.make("child"),
  lineage: { rootThreadId: parent.id, parentThreadId: parent.id, relationshipToParent: "subagent" },
});
const other = makeThreadFixture({
  id: ThreadId.make("other"),
  environmentId: EnvironmentId.make("other-environment"),
  createdAt: "2026-01-02T00:00:00.000Z",
});
const archived = makeThreadFixture({
  id: ThreadId.make("archived"),
  archivedAt: "2026-01-02T00:00:00.000Z",
});

describe("project timestamp projection", () => {
  it.each(["created_at", "updated_at"] as const)(
    "reports the latest visible thread timestamp across environments with %s sorting",
    (sortOrder) => {
      const recent = makeThreadFixture({
        ...other,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-09T00:00:00.000Z",
        latestUserMessageAt: "2026-01-04T00:00:00.000Z",
      });
      const result = projectLastCodeProjectThreads(
        [
          makeThreadFixture({ ...parent, latestUserMessageAt: "2026-01-03T00:00:00.000Z" }),
          recent,
          makeThreadFixture({ ...archived, latestUserMessageAt: "2026-01-10T00:00:00.000Z" }),
          makeThreadFixture({ ...child, deletedAt: "2026-01-11T00:00:00.000Z" }),
        ],
        sortOrder,
        {
          collapsedByKey: {},
          activeThreadKey: null,
          projectExpanded: false,
          previewCount: 1,
          listExpanded: false,
          groupingStyle: "minimal",
        },
      );
      expect(result.latestThreadTimestamp).toBe("2026-01-04T00:00:00.000Z");
      expect(result.familyProjection.renderedRows).toEqual([]);
    },
  );
  it("has no latest thread timestamp for an empty project", () => {
    expect(
      projectLastCodeProjectThreads([], "created_at", {
        collapsedByKey: {},
        activeThreadKey: null,
        projectExpanded: false,
        previewCount: 1,
        listExpanded: false,
        groupingStyle: "minimal",
      }).latestThreadTimestamp,
    ).toBeNull();
  });
});
