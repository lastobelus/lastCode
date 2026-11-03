import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { SidebarProvider } from "../../components/ui/sidebar";
import { useTagFilterStore } from "./state";
import { TagSidebarResults } from "./TagSidebar";

vi.mock("../../components/sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: vi.fn() }));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { hiddenThreadTagsAtom: Atom.family(() => Atom.make(null)) } };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      hiddenThreadKeysAtom: Atom.make(new Set<string>()),
      threadRefsAtom: Atom.make([]),
    },
  };
});
vi.mock("./state", async () => {
  const { create } = await import("zustand");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { EnvironmentId } = await import("@t3tools/contracts");
  const { makeThreadFixture } = await import("../../test-fixtures");
  const pages = Atom.family((key: string) => {
    const { archived, cursor } = JSON.parse(key) as { archived: boolean; cursor: number };
    const title = archived
      ? "Archived match"
      : cursor === 0
        ? "First active page"
        : "Second active page";
    return Atom.make(
      AsyncResult.success({
        threads: archived && cursor > 0 ? [] : [makeThreadFixture({ title }).source],
        nextCursor: !archived && cursor === 0 ? 100 : null,
      }),
    );
  });
  return {
    useTagFilterStore: create<{
      tag: string | null;
      archived: boolean;
      select: (tag: string | null) => void;
      setArchived: (archived: boolean) => void;
    }>((set) => ({
      tag: null,
      archived: false,
      select: (tag) => set({ tag }),
      setArchived: (archived) => set({ archived }),
    })),
    useTagEnvironmentIds: () => [EnvironmentId.make("local")],
    tagMatches: ({ input }: { input: unknown }) => pages(JSON.stringify(input)),
  };
});

it("restarts pagination when another control changes the archive scope", async () => {
  useTagFilterStore.setState({ tag: "Work", archived: false });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <SidebarProvider>
        <TagSidebarResults tag="Work" />
      </SidebarProvider>
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("First active page")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
  await expect.element(screen.getByText("Second active page")).toBeVisible();
  await act(() => useTagFilterStore.getState().setArchived(true));
  await expect.element(screen.getByText("Archived match")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Previous", exact: true }))
    .not.toBeInTheDocument();
  await act(() => useTagFilterStore.getState().setArchived(false));
  await expect.element(screen.getByText("First active page")).toBeVisible();
});
