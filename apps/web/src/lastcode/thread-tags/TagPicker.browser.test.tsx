import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { TagPicker } from "./TagPicker";

vi.mock("./state", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { rankThreadTagVocabulary } = await import("@t3tools/shared/threadTags");
  return {
    tagVocabulary: ({ input }: { input: { query?: string } }) =>
      Atom.make(
        AsyncResult.success({
          entries: rankThreadTagVocabulary(
            [{ tag: "research/ui", count: 2, projectCount: 1 }],
            input.query,
          ),
          nextCursor: null,
        }),
      ),
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
