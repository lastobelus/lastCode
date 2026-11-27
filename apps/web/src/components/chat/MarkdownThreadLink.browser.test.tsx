import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { parseThreadLinkReference } from "@t3tools/shared/threadLinks";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { isMacPlatform } from "../../lib/utils";
import { linkedThreadSurface } from "../../linkedThreadSurface";
import {
  serializeTableElementToCsv,
  serializeTableElementToHtml,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const HERE = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("here"));
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, HERE);

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "title" | "projectId" | "lineage"> & {
  readonly environmentId: EnvironmentId;
};

const state = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    reply: null as unknown,
    identitiesAtom: Atom.make<ReadonlyArray<{ environmentId: EnvironmentId }>>([
      { environmentId: "environment" as EnvironmentId },
      { environmentId: "remote" as EnvironmentId },
      { environmentId: "saved-vm" as EnvironmentId },
    ]).pipe(Atom.keepAlive),
    remote: null as Shell | null,
    linked: new Map<string, string>(),
    connected: [] as Array<string>,
    threadRefsAtom: Atom.make<ReadonlyArray<ScopedThreadRef>>([]).pipe(Atom.keepAlive),
    threadShellAtom: Atom.family((_key: string) =>
      Atom.make<Shell | null>(null).pipe(Atom.keepAlive),
    ),
  };
});
vi.mock(import("../../state/threads"), () => ({
  environmentThreadShells: {
    threadRefsAtom: state.threadRefsAtom,
    threadShellAtom: (ref: ScopedThreadRef) =>
      state.threadShellAtom(JSON.stringify([ref.environmentId, ref.threadId])),
  } as never,
}));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: (() => ({ data: null, isPending: false })) as never,
}));
vi.mock(import("../../state/entities"), () => ({
  useThreadShell: ((ref: { environmentId: string } | null) =>
    ref?.environmentId === "remote" ? state.remote : null) as never,
  useProject: (ref: { projectId: string } | null) =>
    ref?.projectId === "essay-project" ? ({ title: "Essays" } as never) : null,
}));
vi.mock(import("../../state/environments"), () => ({
  // The click rule reads the client setting, whose module asks for these.
  useEnvironments: (() => []) as never,
  usePrimaryEnvironment: (() => null) as never,
  useConnectedEnvironmentIds: () => state.connected as never,
}));
vi.mock(import("../../state/peerLinks"), () => ({
  useLinkedEnvironments: ((environmentId: string | null) =>
    environmentId === null ? new Map() : state.linked) as never,
}));
vi.mock(import("../../state/presentation"), () => ({
  environmentSummaries: { identitiesAtom: state.identitiesAtom } as never,
  useEnvironmentPresentation: () =>
    ({
      isReady: true,
      presentation: {
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { universalThreadReferences: true } } },
      },
    }) as never,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/queries"), () => ({
  useThreadSearch: () => ({
    matches: [],
    query: "",
    isPending: false,
    failed: false,
    mentionCandidates: [],
    mentionResolvedEnvironments: [],
  }),
}));
vi.mock(import("../ProjectFavicon"), () => ({
  ProjectFavicon: () => (
    <span role="img" aria-label="Essays project icon">
      P
    </span>
  ),
}));
vi.mock(import("../ThreadChipHoverCard"), () => ({ ThreadChipHoverCard: () => <span /> }));
vi.mock(import("../contextChipParts"), () => ({
  UnresolvedChip: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock(import("../../state/orchestration"), () => ({
  orchestrationEnvironment: { threadLinkMetadata: () => state.reply } as never,
}));

function setup() {
  const reply = Atom.make<
    AsyncResult.AsyncResult<Record<string, { title: string; projectId: ProjectId | null }>, string>
  >(AsyncResult.initial());
  state.reply = reply;
  state.linked = new Map();
  state.connected = ["environment", "remote"];
  useRightPanelStore.setState({ byThreadKey: {} });
  const remote: Shell = {
    environmentId: EnvironmentId.make("remote"),
    id: ThreadId.make("older-thread"),
    title: "Remote thread",
    projectId: ProjectId.make("essay-project"),
    lineage: {
      rootThreadId: ThreadId.make("older-thread"),
      parentThreadId: null,
      relationshipToParent: null,
    },
  };
  state.remote = remote;
  const registry = AtomRegistry.make();
  const remoteRef = { environmentId: remote.environmentId, threadId: remote.id };
  registry.set(state.threadRefsAtom, [remoteRef]);
  registry.set(
    state.threadShellAtom(JSON.stringify([remoteRef.environmentId, remoteRef.threadId])),
    remote,
  );
  return { reply, registry };
}

async function renderThreadLink(ui: ReactNode) {
  const root = createRootRoute({ component: () => ui });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
  const thread = createRoute({
    getParentRoute: () => chat,
    path: "$environmentId/$threadId",
  });
  const linkedThread = createRoute({
    getParentRoute: () => chat,
    path: "linked/$viaEnvironmentId/$linkedEnvironmentId/$linkedThreadId",
  });
  const router = createRouter({
    routeTree: root.addChildren([index, chat.addChildren([thread, linkedThread])]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  return Object.assign(
    await render(<RouterProvider router={router} />, {
      // The chip validates its destination against the matching thread route.
      router: false,
    }),
    { router },
  );
}

it.each([
  { legacy: false, encoded: false },
  { legacy: true, encoded: false },
  { legacy: false, encoded: true },
])(
  "resolves an unloaded thread with its icon and the correct destination, %j",
  async ({ legacy, encoded }) => {
    const { reply, registry } = setup();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const environmentId = EnvironmentId.make("environment");
    const reference = parseThreadLinkReference(
      legacy
        ? "t3-thread://v1/older-thread"
        : encoded
          ? "t3-thread://v1/environment/older%2Dthread"
          : "t3-thread://v2/environment/older-thread",
    )!;
    const { threadId } = reference;
    await using screen = await renderThreadLink(
      <RegistryContext value={registry}>
        <MarkdownThreadLink environmentId={environmentId} reference={reference} label={null} />
      </RegistryContext>,
    );
    await expect
      .element(screen.getByRole("link", { name: "Thread, Thread", exact: true }))
      .toBeVisible();
    await act(() => registry.set(reply, AsyncResult.failure(Cause.fail("offline"))));
    await expect
      .element(screen.getByRole("link", { name: "Thread, Thread", exact: true }))
      .toBeVisible();
    await act(() =>
      registry.set(
        reply,
        AsyncResult.success({
          [threadId]: { title: "Older essay", projectId: ProjectId.make("essay-project") },
          ...(encoded
            ? {
                "older-thread": {
                  title: "Decoded essay",
                  projectId: ProjectId.make("essay-project"),
                },
              }
            : {}),
        }),
      ),
    );
    const link = screen.getByRole("link", { name: "Thread, Older essay" });
    await expect.element(link).toBeVisible();
    await expect.element(screen.getByRole("img", { name: "Essays project icon" })).toBeVisible();
    await link.click();
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe(
        `/environment/${encodeURIComponent(threadId)}`,
      ),
    );
    if (encoded) {
      await act(() =>
        registry.set(
          reply,
          AsyncResult.success({
            "older-thread": { title: "Decoded essay", projectId: ProjectId.make("essay-project") },
          }),
        ),
      );
      const decoded = screen.getByRole("link", { name: "Thread, Decoded essay" });
      await expect.element(decoded).toBeVisible();
      await decoded.click();
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/environment/older-thread"),
      );
    }
    await act(() => registry.set(reply, AsyncResult.success({})));
    if (legacy) {
      const remote = screen.getByRole("link", { name: "Thread, Remote thread" });
      await expect.element(remote).toBeVisible();
      await remote.click();
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/remote/older-thread"),
      );
    } else {
      await expect
        .element(screen.getByText("Thread no longer available", { exact: true }))
        .toBeVisible();
    }
  },
);

it("names a thread on a machine this client has no connection to, without waiting on it", async () => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await renderThreadLink(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={EnvironmentId.make("environment")}
        reference={{
          environmentId: EnvironmentId.make("peer"),
          threadId: ThreadId.make("peer-thread"),
          version: 2,
        }}
        label={null}
      />
    </RegistryContext>,
  );
  await expect
    .element(screen.getByText("Thread on another machine", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("link")).not.toBeInTheDocument();
});

it.for([
  { name: "a machine only this environment links to", linkedId: "linked-vm" },
  { name: "a saved machine this client is not connected to", linkedId: "saved-vm" },
])("opens a thread on $name as a read through the link", async ({ linkedId }) => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  state.linked = new Map([[linkedId, "fs-17"]]);
  const environmentId = EnvironmentId.make("environment");
  const link = { environmentId: EnvironmentId.make(linkedId), threadId: ThreadId.make("there") };
  await using screen = await renderThreadLink(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={environmentId}
        threadRef={HERE}
        reference={{ ...link, version: 2 }}
        label={null}
      />
    </RegistryContext>,
  );
  const chip = screen.getByRole("button", { name: "Thread, Thread on fs-17" });
  await chip.click();
  const surface = linkedThreadSurface({
    viaEnvironmentId: environmentId,
    ...link,
    label: "fs-17",
    title: null,
  });
  expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: surface.id, surfaces: [surface] });
  await chip.click();
  expect(panel().surfaces).toHaveLength(1);
  expect(screen.router?.state.location.pathname).toBe("/");
  // The modifier reads it on the main screen instead, through the same environment.
  await chip.click({ modifiers: [isMacPlatform(navigator.platform) ? "Meta" : "Control"] });
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/linked/environment/${linkedId}/there`),
  );
  expect(panel().surfaces).toHaveLength(1);
});

it("reads through the link when a disconnected machine's thread is only cached here", async () => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  state.linked = new Map([["saved-vm", "fs-17"]]);
  const environmentId = EnvironmentId.make("environment");
  const link = { environmentId: EnvironmentId.make("saved-vm"), threadId: ThreadId.make("there") };
  registry.set(state.threadShellAtom(JSON.stringify([link.environmentId, link.threadId])), {
    environmentId: link.environmentId,
    id: link.threadId,
    title: "Cached title",
    projectId: ProjectId.make("essay-project"),
    lineage: { rootThreadId: link.threadId, parentThreadId: null, relationshipToParent: null },
  });
  await using screen = await renderThreadLink(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={environmentId}
        threadRef={HERE}
        reference={{ ...link, version: 2 }}
        label={null}
      />
    </RegistryContext>,
  );
  await screen.getByRole("button", { name: "Thread, Cached title" }).click();
  expect(panel().surfaces).toEqual([
    linkedThreadSurface({
      viaEnvironmentId: environmentId,
      ...link,
      label: "fs-17",
      title: "Cached title",
    }),
  ]);
});

it("opens a linked machine's thread directly once this client is connected to it", async () => {
  const { registry, reply } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  state.linked = new Map([["saved-vm", "fs-17"]]);
  state.connected = ["environment", "saved-vm"];
  registry.set(reply, AsyncResult.success({ there: { title: "Fix the build", projectId: null } }));
  await using screen = await renderThreadLink(
    <RegistryContext value={registry}>
      <MarkdownThreadLink
        environmentId={EnvironmentId.make("environment")}
        threadRef={HERE}
        reference={parseThreadLinkReference("t3-thread://v2/saved-vm/there")!}
        label={null}
      />
    </RegistryContext>,
  );
  await expect.element(screen.getByText("Fix the build")).toBeVisible();
  await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  await screen.getByRole("link", { name: "Thread, Fix the build" }).click();
  await vi.waitFor(() => expect(screen.router.state.location.pathname).toBe("/saved-vm/there"));
});

it("keeps a linked environment thread label when copying a table", async () => {
  const { registry } = setup();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  state.linked = new Map([["linked-vm", "fs-17"]]);
  await using screen = await render(
    <RegistryContext value={registry}>
      <table>
        <thead>
          <tr>
            <th>Thread</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <MarkdownThreadLink
                environmentId={EnvironmentId.make("environment")}
                threadRef={HERE}
                reference={{
                  version: 2,
                  environmentId: EnvironmentId.make("linked-vm"),
                  threadId: ThreadId.make("there"),
                }}
                label="Linked thread"
              />
            </td>
            <td>ready</td>
          </tr>
        </tbody>
      </table>
    </RegistryContext>,
  );
  const table = screen.container.querySelector("table")!;
  expect(serializeTableElementToCsv(table)).toBe("Thread,Status\nLinked thread,ready");
  expect(serializeTableElementToMarkdown(table)).toBe(
    "| Thread | Status |\n| --- | --- |\n| [Linked thread](https://app.t3.codes/threads/linked-vm/there) | ready |",
  );
  expect(serializeTableElementToHtml(table)).toContain(">Linked thread</td>");
});
