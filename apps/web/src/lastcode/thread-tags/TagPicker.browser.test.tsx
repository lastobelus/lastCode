import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "../../../test/render";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { TagPicker } from "./TagPicker";

const delayed = vi.hoisted(() => ({
  finish: null as ((registry: AtomRegistry.AtomRegistry) => void) | null,
}));

vi.mock("./state", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { rankThreadTagVocabulary } = await import("@t3tools/shared/threadTags");
  const searches = Atom.family((query: string) => {
    const pending = query === "new/path";
    const atom = Atom.make(
      AsyncResult.success(
        {
          entries: pending
            ? [{ tag: "work", count: 1, projectCount: 1 }]
            : rankThreadTagVocabulary(
                [
                  { tag: "research/ui", count: 2, projectCount: 1 },
                  { tag: "work", count: 1, projectCount: 1 },
                ],
                query,
              ),
        },
        { waiting: pending },
      ),
    );
    if (pending)
      delayed.finish = (registry) => registry.set(atom, AsyncResult.success({ entries: [] }));
    return atom;
  });
  return {
    tagVocabulary: ({ input }: { input: { query?: string } }) => searches(input.query ?? ""),
  };
});

it("selects fuzzy matches and creates exact paths with the keyboard", async () => {
  const select = vi.fn();
  await using screen = await render(
    <TagPicker environmentIds={[EnvironmentId.make("local")]} allowCreate onSelect={select} />,
  );
  const search = screen.getByRole("combobox", { name: "Search tags" });
  await userEvent.type(search, "rsui");
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenLastCalledWith("research/ui");
  await userEvent.clear(search);
  await userEvent.type(search, "#experiment/layout");
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenLastCalledWith("experiment/layout");
  await screen.rerender(
    <TagPicker
      environmentIds={[EnvironmentId.make("local")]}
      allowCreate
      disabled
      onSelect={select}
    />,
  );
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenCalledTimes(2);
});

it("does not submit a selected old tag while the new search is pending", async () => {
  const select = vi.fn();
  const registry = AtomRegistry.make();
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <TagPicker
        environmentIds={[EnvironmentId.make("local")]}
        projectId={ProjectId.make("project")}
        selected={["work"]}
        allowCreate
        onSelect={select}
      />
    </RegistryContext.Provider>,
  );
  await userEvent.type(screen.getByRole("combobox", { name: "Search tags" }), "new/path");
  await userEvent.keyboard("{Enter}");
  expect(select).not.toHaveBeenCalled();
  await act(() => delayed.finish!(registry));
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("new/path");
});
