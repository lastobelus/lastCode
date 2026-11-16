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
  const searches = Atom.family((projectId: string | undefined) => {
    const entries = [
      { tag: "research/ui", count: 2, projectCount: 1 },
      { tag: "work", count: 1, projectCount: 1 },
      { tag: "bugfix", count: 1, projectCount: 1 },
      { tag: "Work/Client", count: 1, projectCount: 1, preferredProject: true },
      { tag: "WC", count: 1, projectCount: 1 },
    ];
    const pending = projectId === "pending";
    const atom = Atom.make(AsyncResult.success({ entries }, { waiting: pending }));
    if (pending)
      delayed.finish = (registry) => registry.set(atom, AsyncResult.success({ entries }));
    return atom;
  });
  return {
    tagVocabulary: ({ input }: { input: { preferredProjectId?: string } }) =>
      searches(input.preferredProjectId),
  };
});

it("selects fuzzy matches and creates exact paths with the keyboard", async () => {
  const select = vi.fn();
  await using screen = await render(
    <TagPicker environmentIds={[EnvironmentId.make("local")]} onSelect={select} />,
  );
  const search = screen.getByRole("combobox", { name: "Search tags" });
  await userEvent.type(search, "rsui");
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenLastCalledWith("research/ui");
  await screen.rerender(
    <TagPicker environmentIds={[EnvironmentId.make("local")]} allowCreate onSelect={select} />,
  );
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
        projectId={ProjectId.make("pending")}
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

it("creates a shorter exact tag without removing a selected fuzzy match", async () => {
  const select = vi.fn();
  await using screen = await render(
    <TagPicker
      environmentIds={[EnvironmentId.make("local")]}
      selected={["bugfix"]}
      allowCreate
      onSelect={select}
    />,
  );
  await userEvent.type(screen.getByRole("combobox", { name: "Search tags" }), "bug");
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("bug");
  await userEvent.click(screen.getByText("#bugfix", { exact: true }));
  expect(select).toHaveBeenLastCalledWith("bugfix");
});
it("submits an exact existing candidate ahead of a preferred fuzzy match", async () => {
  const select = vi.fn();
  await using screen = await render(
    <TagPicker
      environmentIds={[EnvironmentId.make("local")]}
      projectId={ProjectId.make("project")}
      allowCreate
      onSelect={select}
    />,
  );
  await userEvent.type(screen.getByRole("combobox", { name: "Search tags" }), "WC");
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("WC");
});
