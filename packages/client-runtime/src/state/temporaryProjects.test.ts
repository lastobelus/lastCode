import { AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { discoverableProjects, showTemporaryProjectsAtom } from "./temporaryProjects.ts";

it("hides only marked project records until reveal or Keep", () => {
  const registry = AtomRegistry.make();
  const ordinary = { id: "ordinary" };
  const kept = { id: "kept", temporary: false };
  const temporary = { id: "temporary", temporary: true };
  const projects: ReadonlyArray<{ id: string; temporary?: boolean }> = [ordinary, kept, temporary];

  expect(discoverableProjects(projects, registry.get(showTemporaryProjectsAtom))).toEqual([
    ordinary,
    kept,
  ]);
  registry.set(showTemporaryProjectsAtom, true);
  expect(discoverableProjects(projects, registry.get(showTemporaryProjectsAtom))).toBe(projects);
  registry.set(showTemporaryProjectsAtom, false);

  const afterKeep: typeof projects = [ordinary, kept, { ...temporary, temporary: false }];
  expect(discoverableProjects(afterKeep, registry.get(showTemporaryProjectsAtom))).toBe(afterKeep);
});
