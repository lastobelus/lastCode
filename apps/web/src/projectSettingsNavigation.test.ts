import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { expect, it } from "vite-plus/test";

import {
  contextualProjectActionTarget,
  contextualProjectSettings,
} from "./projectSettingsNavigation";

it("opens settings for the active temporary checkout even when no project is discoverable", () => {
  const project: EnvironmentProject = {
    id: ProjectId.make("evaluation"),
    environmentId: EnvironmentId.make("local"),
    title: "Evaluation",
    workspaceRoot: "/work/evaluation",
    temporary: true,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  const target = contextualProjectActionTarget(null, project, {
    sidebarProjectGroupingMode: "separate",
    sidebarProjectGroupingOverrides: {},
  })!;
  expect(contextualProjectSettings(target.key, project)).toEqual({
    to: "/settings/projects",
    search: {
      project: "local:/work/evaluation",
      machine: "local",
      checkout: "local:/work/evaluation",
    },
  });
});
