import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

const transport = vi.hoisted(() => ({
  lists: new Map<string, Atom.Writable<AsyncResult.AsyncResult<PreviewListResult, never>>>(),
  events: new Map<string, Atom.Writable<AsyncResult.AsyncResult<PreviewEvent, never>>>(),
}));
vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/state/entities", () => ({ readEnvironmentSupportsServerBrowser: () => true }));
vi.mock("~/state/presentation", async () => ({
  environmentSummaries: {
    connectedEnvironmentIdsAtom: (await import("effect/reactivity")).Atom.make([]),
  },
}));
vi.mock("~/state/primaryEnvironment", async () => ({
  primaryEnvironmentIdAtom: (await import("effect/reactivity")).Atom.make(null),
}));
vi.mock("./serverBrowserHandoff", () => ({ recordServerBrowserHandoff: async () => {} }));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => ({ browserAutoShowFloatingPreview: false }),
}));
vi.mock("~/state/preview", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    previewEnvironment: {
      list: ({ input }: { input: { threadId: string } }) => {
        let atom = transport.lists.get(input.threadId);
        if (!atom) {
          atom = Atom.make<AsyncResult.AsyncResult<PreviewListResult, never>>(
            AsyncResult.initial(),
          );
          transport.lists.set(input.threadId, atom);
        }
        return atom;
      },
      events: ({ environmentId }: { environmentId: string }) => {
        let atom = transport.events.get(environmentId);
        if (!atom) {
          atom = Atom.make<AsyncResult.AsyncResult<PreviewEvent, never>>(AsyncResult.initial());
          transport.events.set(environmentId, atom);
        }
        return atom;
      },
    },
  };
});

import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { resetPreviewStateForTests, readThreadPreviewState } from "~/previewStateStore";
import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { HostedPreviewSessions } from "./HostedPreviewSessions";
import { startAgentOpenedPreviews } from "./agentOpenedPreviews";

it.each(["side-chat", "preview"] as const)(
  "receives owner opens while a hosted %s is hidden",
  async (kind) => {
    transport.lists.clear();
    transport.events.clear();
    resetPreviewStateForTests();
    const host = scopeThreadRef(EnvironmentId.make(`hosted-${kind}`), ThreadId.make("parent"));
    const child = scopeThreadRef(host.environmentId, ThreadId.make("child"));
    const source: RightPanelSurface =
      kind === "side-chat"
        ? { id: "side-chat:child", kind, threadId: child.threadId }
        : { id: "browser:child:old", kind, resourceId: "old", sourceThreadRef: child };
    const surfaces: RightPanelSurface[] = [source, { id: "files", kind: "files" }];
    useRightPanelStore.setState({
      byThreadKey: {
        [scopedThreadKey(host)]: { surfaces, isOpen: false, activeSurfaceId: "files" },
      },
    });
    using _following = { [Symbol.dispose]: startAgentOpenedPreviews() };
    // This component only maintains event subscriptions and does not use navigation.
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <HostedPreviewSessions threadRef={host} surfaces={surfaces} />
      </AppAtomRegistryProvider>,
      { router: false },
    );
    await act(async () => {
      appAtomRegistry.set(
        transport.lists.get(child.threadId)!,
        AsyncResult.success({ serverEpoch: "epoch", revision: 0, sessions: [] }),
      );
      appAtomRegistry.set(
        transport.events.get(host.environmentId)!,
        AsyncResult.success({
          type: "navigated",
          threadId: child.threadId,
          tabId: "new",
          serverEpoch: "epoch",
          revision: 1,
          createdAt: "2026-01-01T00:00:00Z",
          snapshot: {
            threadId: child.threadId,
            tabId: "new",
            runtime: "server",
            reveal: true,
            revealRequest: { id: "new-reveal", force: true },
            navStatus: { _tag: "Success", url: "https://page.example/", title: "Page" },
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        }),
      );
    });
    expect(readThreadPreviewState(child).sessions.new).toBeDefined();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, host),
    ).toMatchObject({ kind: "preview", resourceId: "new", sourceThreadRef: child });
  },
);
