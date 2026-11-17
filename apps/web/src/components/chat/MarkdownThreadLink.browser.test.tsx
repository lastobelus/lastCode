import { RegistryContext } from "@effect/atom-react";
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
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "title" | "projectId"> & {
  readonly environmentId: EnvironmentId;
};

const state = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    reply: null as unknown,
    identitiesAtom: Atom.make<ReadonlyArray<{ environmentId: EnvironmentId }>>([
      { environmentId: "environment" as EnvironmentId },
      { environmentId: "remote" as EnvironmentId },
    ]).pipe(Atom.keepAlive),
    remote: null as Shell | null,
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
  useEnvironmentIdentities: () => [
    { environmentId: EnvironmentId.make("environment"), label: "Here" },
    { environmentId: EnvironmentId.make("remote"), label: "Remote" },
  ],
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
vi.mock(import("../../state/session"), () => ({
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/queries"), () => ({
  useThreadSearch: () => ({
    matches: [],
    query: "",
    isPending: false,
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
  state.remote = {
    environmentId: EnvironmentId.make("remote"),
    id: ThreadId.make("older-thread"),
    title: "Remote thread",
    projectId: ProjectId.make("essay-project"),
  };
  const registry = AtomRegistry.make();
  const remoteRef = { environmentId: state.remote.environmentId, threadId: state.remote.id };
  registry.set(state.threadRefsAtom, [remoteRef]);
  registry.set(
    state.threadShellAtom(JSON.stringify([remoteRef.environmentId, remoteRef.threadId])),
    state.remote,
  );
  return { reply, registry };
}

it.each([
  { legacy: false, encoded: false, version: 2 as const },
  { legacy: true, encoded: false, version: 1 as const },
  { legacy: false, encoded: true, version: 1 as const },
])(
  "resolves an unloaded thread with its icon and the correct destination, %j",
  async ({ legacy, encoded, version }) => {
    const { reply, registry } = setup();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const environmentId = EnvironmentId.make("environment");
    const threadId = ThreadId.make(encoded ? "older%2Dthread" : "older-thread");
    const ui = (
      <RegistryContext value={registry}>
        <MarkdownThreadLink
          environmentId={environmentId}
          reference={{
            environmentId: legacy ? undefined : environmentId,
            threadId,
            version,
            legacyThreadId: encoded ? ThreadId.make(`${environmentId}/${threadId}`) : undefined,
          }}
          label={null}
        />
      </RegistryContext>
    );
    const root = createRootRoute({ component: () => ui });
    const index = createRoute({ getParentRoute: () => root, path: "/" });
    const chat = createRoute({ getParentRoute: () => root, id: "_chat" });
    const thread = createRoute({
      getParentRoute: () => chat,
      path: "$environmentId/$threadId",
    });
    const router = createRouter({
      routeTree: root.addChildren([index, chat.addChildren([thread])]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    await using screen = Object.assign(
      await render(<RouterProvider router={router} />, {
        // The chip validates its destination against the matching thread route.
        router: false,
      }),
      { router },
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
  await using screen = await render(
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
