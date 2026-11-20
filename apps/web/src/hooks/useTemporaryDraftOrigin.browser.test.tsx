import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { DraftId } from "../composerDraftStore";
import { useTemporaryDraftOrigin } from "./useTemporaryDraftOrigin";

const resources = vi.hoisted(() => ({ projects: [] as EnvironmentProject[] }));

vi.mock("../state/entities", () => ({
  useProject: (ref: ScopedProjectRef | null) =>
    resources.projects.find(
      (project) => project.environmentId === ref?.environmentId && project.id === ref.projectId,
    ) ?? null,
}));

function makeProject(id: string, environment: string): EnvironmentProject {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make(environment),
    title: id,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function OriginProbe({
  temporary,
  ordinary,
  other,
}: {
  temporary: EnvironmentProject;
  ordinary: EnvironmentProject;
  other: EnvironmentProject;
}) {
  const [active, setActive] = useState(temporary);
  const { origin, rememberRetarget } = useTemporaryDraftOrigin(DraftId.make("draft"), active);

  return (
    <>
      <output>{origin?.id ?? "None"}</output>
      <button
        onClick={() => {
          rememberRetarget(scopeProjectRef(ordinary.environmentId, ordinary.id));
          setActive(ordinary);
        }}
      >
        Switch environment
      </button>
      <button onClick={() => setActive(other)}>Choose another project</button>
    </>
  );
}

function setup() {
  const temporary = { ...makeProject("temporary", "a"), temporary: true };
  const ordinary = makeProject("ordinary", "b");
  const other = makeProject("other", "b");
  resources.projects = [temporary, ordinary, other];
  return { temporary, ordinary, other };
}

it("retains the exact temporary draft checkout across a machine switch and clears it on project selection", async () => {
  const { temporary, ordinary, other } = setup();

  await using screen = await render(
    <OriginProbe temporary={temporary} ordinary={ordinary} other={other} />,
    { router: false },
  ); // The hook has no route dependency.
  await screen.getByRole("button", { name: "Switch environment" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("temporary");
  await screen.getByRole("button", { name: "Choose another project" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("None");
});
