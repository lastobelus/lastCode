import { describe, expect, it } from "vite-plus/test";

import { projectsContainPersistentThread } from "./projectPersistence.logic";

describe("project persistence protection", () => {
  it("finds a persistent thread in any selected environment/project member", () => {
    expect(
      projectsContainPersistentThread({
        members: [
          { environmentId: "environment-a", id: "project-a" },
          { environmentId: "environment-b", id: "project-b" },
        ],
        threads: [
          {
            environmentId: "environment-b",
            projectId: "project-b",
            persistent: true,
          },
        ],
      }),
    ).toBe(true);
  });

  it("does not match a same-id project from another environment", () => {
    expect(
      projectsContainPersistentThread({
        members: [{ environmentId: "environment-a", id: "project-a" }],
        threads: [
          {
            environmentId: "environment-b",
            projectId: "project-a",
            persistent: true,
          },
        ],
      }),
    ).toBe(false);
  });
});
