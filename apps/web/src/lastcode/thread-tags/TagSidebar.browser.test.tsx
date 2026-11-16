import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
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
vi.mock("../../state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  const { environmentThreadShells } = await import("../../state/threads");
  const { makeThreadFixture } = await import("../../test-fixtures");
  const { ThreadId, EnvironmentId } = await import("@t3tools/contracts");
  const parent = makeThreadFixture({
    id: ThreadId.make("private-parent"),
    environmentId: EnvironmentId.make("local"),
    title: "Private parent title",
  });
  return {
    useProjects: () => [],
    useQuietThreadShell: () => null,
    useQuietThreadShells: () => [parent],
    useHiddenThreadKeys: () => useAtomValue(environmentThreadShells.hiddenThreadKeysAtom),
  };
});
vi.mock("../../components/sidebar/useLastCodeThreadStatus", () => ({
  useLastCodeThreadStatus: () => null,
}));
vi.mock("../../components/sidebar/LastCodeThreadStatusLabel", () => ({
  LastCodeThreadStatusLabel: () => null,
}));
vi.mock("../../state/queries", async () => {
  const { EnvironmentId, MessageId, ThreadId } = await import("@t3tools/contracts");
  return {
    useThreadSearch: (_ids: unknown, query: string) => ({
      matches:
        query === "body phrase"
          ? [
              {
                environmentId: EnvironmentId.make("local"),
                threadId: ThreadId.make("second"),
                messageId: MessageId.make("message"),
              },
            ]
          : [],
      query,
      isPending: false,
    }),
  };
});
vi.mock("../../components/chat/threadFindStore", () => ({
  openThreadFindOnQuery: vi.fn(),
  findForMessageMatch: (match: { messageId: string }, query: string) => ({
    messageId: match.messageId,
    query,
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: vi.fn(),
  useClientSetting: () => ({}),
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { hiddenThreadTagsAtom: Atom.family(() => Atom.make(null)) } };
});
vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadFamilies: { mountRows: () => () => {} },
    environmentThreadShells: {
      hiddenThreadKeysAtom: Atom.make(new Set<string>()),
      threadRefsAtom: Atom.make([]),
      anyEnvironmentHidingAtom: Atom.make(false),
    },
  };
});
vi.mock("./state", async () => {
  const { create } = await import("zustand");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { EnvironmentId, ThreadId } = await import("@t3tools/contracts");
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
        snapshotSequence: 0,
        threads: archived
          ? cursor > 0
            ? []
            : [makeThreadFixture({ title }).source]
          : cursor === 0
            ? Array.from(
                { length: 100 },
                (_, index) =>
                  makeThreadFixture({
                    id: ThreadId.make(`first-${index}`),
                    title: index === 0 ? title : `Other match ${index}`,
                    branch: index === 0 ? "fix/spacing" : null,
                  }).source,
              )
            : [
                {
                  ...makeThreadFixture({ id: ThreadId.make("second"), title }).source,
                  groupedUnderThreadId: ThreadId.make("private-parent"),
                },
                {
                  ...makeThreadFixture({
                    id: ThreadId.make("private"),
                    title: "Private tagged thread",
                  }).source,
                  tags: ["Work", "private"],
                },
                {
                  ...makeThreadFixture({
                    id: ThreadId.make("zz-visible-child"),
                    title: "Visible delegated child",
                  }).source,
                  delegatedFrom: {
                    environmentId: EnvironmentId.make("remote"),
                    threadId: ThreadId.make("visible-parent"),
                  },
                },
              ],
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

it("searches the complete tagged set and keeps message-only jump targets", async () => {
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
  await userEvent.fill(screen.getByRole("searchbox", { name: "Search tagged threads" }), "spacing");
  await expect.element(screen.getByText("First active page")).toBeVisible();
  await expect.element(screen.getByText("Other match 1", { exact: true })).not.toBeInTheDocument();
  await userEvent.fill(
    screen.getByRole("searchbox", { name: "Search tagged threads" }),
    "body phrase",
  );
  await expect.element(screen.getByText("Second active page")).toBeVisible();
  await expect.element(screen.getByText("First active page")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("link", { name: /Second active page/ }));
  const { openThreadFindOnQuery } = await import("../../components/chat/threadFindStore");
  expect(openThreadFindOnQuery).toHaveBeenCalledWith(expect.any(String), {
    messageId: "message",
    query: "body phrase",
  });
});

it("applies real privacy keys to tagged results", async () => {
  useTagFilterStore.setState({ tag: "Work", archived: false });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const { serverEnvironment } = await import("../../state/server");
  const { environmentThreadShells } = await import("../../state/threads");
  const { EnvironmentId, ThreadId } = await import("@t3tools/contracts");
  const { makeThreadFixture } = await import("../../test-fixtures");
  const { hiddenThreadKeys } = await import("@t3tools/shared/threadTags");
  registry.set(
    environmentThreadShells.threadRefsAtom as Atom.Writable<
      readonly import("@t3tools/contracts").ScopedThreadRef[]
    >,
    [{ environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("visible-parent") }],
  );
  registry.set(
    environmentThreadShells.hiddenThreadKeysAtom as Atom.Writable<ReadonlySet<string>>,
    hiddenThreadKeys([
      {
        environmentId: EnvironmentId.make("local"),
        threads: [
          {
            ...makeThreadFixture({ id: ThreadId.make("private-parent") }).source,
            tags: ["private"],
          },
        ],
        hiddenTags: ["private"],
      },
    ]),
  );
  registry.set(
    serverEnvironment.hiddenThreadTagsAtom(EnvironmentId.make("local")) as Atom.Writable<
      readonly string[] | null
    >,
    ["private"],
  );
  registry.set(environmentThreadShells.anyEnvironmentHidingAtom as Atom.Writable<boolean>, true);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <SidebarProvider>
        <TagSidebarResults tag="Work" />
      </SidebarProvider>
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
  await expect.element(screen.getByText("Second active page")).toBeVisible();
  await expect.element(screen.getByText("Private tagged thread")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Visible delegated child")).toBeVisible();
  await expect
    .element(screen.getByText("Group: Private parent title", { exact: false }))
    .not.toBeInTheDocument();
});
