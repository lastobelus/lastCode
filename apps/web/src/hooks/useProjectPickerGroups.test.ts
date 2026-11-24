import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { draftProjectChoices } from "./useProjectPickerGroups";

it("skips hidden checkouts as draft destinations and retains the active temporary checkout", () => {
  const local = EnvironmentId.make("local");
  const kept = { environmentId: local, id: ProjectId.make("kept"), temporary: false };
  const active = { ...kept, id: ProjectId.make("active"), temporary: true };
  const hidden = { ...active, environmentId: EnvironmentId.make("remote") };
  const projects = [kept, hidden, active];

  expect(draftProjectChoices(projects, false, kept)).toEqual([kept]);
  expect(draftProjectChoices(projects, false, active)).toEqual([active, kept]);
  expect(draftProjectChoices(projects, true, active)).toEqual([active, kept, hidden]);
});
