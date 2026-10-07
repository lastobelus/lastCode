import {
  AuthPreviewOperateScope,
  EnvironmentId,
  WS_METHODS,
  type AuthEnvironmentScope,
  DesktopBrowserEventInput,
  type PreviewEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { it } from "@effect/vitest";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";

type BrowserEventInput = typeof DesktopBrowserEventInput.Type;

const state = vi.hoisted(() => ({
  allowed: false,
  permissionListeners: new Set<() => void>(),
  browserListeners: new Set<(input: BrowserEventInput) => void>(),
  streams: [] as Stream.Stream<unknown>[],
  browserCommand: vi.fn(async () => undefined),
  sendEvent: vi.fn(async () => undefined),
  previewEvents: [] as PreviewEvent[],
  applyPreviewEvent: vi.fn(),
  readPreviewState: vi.fn(() => ({ serverEpoch: null })),
  recordHandoff: vi.fn(),
  forgetHandoff: vi.fn(),
}));

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

vi.mock("~/state/environments", () => ({
  useConnectedEnvironmentIds: () => [primary, remote],
  usePrimaryEnvironmentId: () => primary,
}));
vi.mock("~/state/session", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentScope: (environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.permissionListeners.add(listener);
          return () => state.permissionListeners.delete(listener);
        },
        () => environmentId === remote && scope === AuthPreviewOperateScope && state.allowed,
      ),
  };
});
vi.mock("~/state/preview", () => ({ previewEnvironment: { browserEvent: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.sendEvent }));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerEvent: state.applyPreviewEvent,
  readThreadPreviewState: state.readPreviewState,
}));
vi.mock("~/components/preview/serverBrowserHandoff", () => ({
  recordServerBrowserHandoff: state.recordHandoff,
  forgetServerBrowserHandoff: state.forgetHandoff,
}));
vi.mock("./desktopBrowserTransport", () => ({
  getDesktopBrowserHostId: (environmentId: EnvironmentId) => `host-${environmentId}`,
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({
  subscribe: (method: string) =>
    method === WS_METHODS.subscribeDesktopBrowserCommands
      ? Stream.fromIterable([
          { type: "cdp", threadId: "thread-1", tabId: "tab-1", message: "page-command" },
        ])
      : Stream.suspend(() => Stream.fromIterable(state.previewEvents)),
}));

// Run the component's real command stream; only the environment/atom plumbing
// is replaced so this test does not need a server or a desktop process.
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentSubscriptionAtomFamily: (
    _runtime: unknown,
    options: { subscribe: (input: never) => Stream.Stream<unknown> },
  ) => {
    const atoms = new Map<string, { stream: Stream.Stream<unknown> }>();
    return (target: { input: never }) => {
      const key = JSON.stringify(target);
      let atom = atoms.get(key);
      if (!atom) {
        atom = { stream: options.subscribe(target.input) };
        atoms.set(key, atom);
      }
      return atom;
    };
  },
}));
vi.mock("@effect/atom-react", async () => {
  const { useEffect } = await import("react");
  return {
    useAtomMount: (atom: { stream: Stream.Stream<unknown> }) => {
      useEffect(() => {
        state.streams.push(atom.stream);
      }, [atom]);
    },
  };
});

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  state.allowed = false;
  state.streams = [];
  state.browserCommand.mockClear();
  state.sendEvent.mockClear();
  state.previewEvents = [];
  state.applyPreviewEvent.mockClear();
  state.readPreviewState.mockClear();
  state.recordHandoff.mockClear();
  state.forgetHandoff.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    desktopBridge: {
      preview: {
        browserCommand: state.browserCommand,
        onBrowserEvent: (listener: (input: BrowserEventInput) => void) => {
          state.browserListeners.add(listener);
          return () => state.browserListeners.delete(listener);
        },
      },
    },
  });
});

it.effect(
  "lets the root host apply primary preview events while preserving remote state and handoffs",
  () =>
    Effect.gen(function* () {
      const opened: PreviewEvent = {
        type: "opened",
        threadId: "background-thread",
        tabId: "background-tab",
        serverEpoch: "server",
        revision: 1,
        createdAt: "2026-10-07T00:00:00.000Z",
        snapshot: {
          threadId: "background-thread",
          tabId: "background-tab",
          runtime: "server",
          navStatus: { _tag: "Idle" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-10-07T00:00:00.000Z",
        },
      };
      const { snapshot: _snapshot, ...openedEnvelope } = opened;
      state.previewEvents = [opened, { ...openedEnvelope, type: "closed", revision: 2 }];
      const { DesktopCdpRelay } = yield* Effect.promise(() => import("./DesktopCdpRelay"));
      yield* Effect.promise(() =>
        act(async () => {
          renderer = create(createElement(DesktopCdpRelay));
        }),
      );
      yield* Effect.all(state.streams.map(Stream.runDrain));
      expect(state.applyPreviewEvent).toHaveBeenCalledTimes(2);
      expect(
        state.applyPreviewEvent.mock.calls.every(([ref]) => ref.environmentId === remote),
      ).toBe(true);
      expect(state.readPreviewState).toHaveBeenCalledTimes(2);
      expect(state.recordHandoff).toHaveBeenCalledWith(
        { environmentId: primary, threadId: opened.threadId },
        opened.snapshot,
      );
      expect(state.recordHandoff).toHaveBeenCalledWith(
        { environmentId: remote, threadId: opened.threadId },
        opened.snapshot,
      );
      expect(state.forgetHandoff).toHaveBeenCalledTimes(2);
    }),
);

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it.effect(
  "relays native browser commands and events only while preview permission is granted",
  () =>
    Effect.gen(function* () {
      const { DesktopCdpRelay } = yield* Effect.promise(() => import("./DesktopCdpRelay"));
      yield* Effect.promise(() =>
        act(async () => {
          renderer = create(createElement(DesktopCdpRelay));
        }),
      );
      yield* Effect.all(state.streams.map(Stream.runDrain));
      expect(state.browserCommand).not.toHaveBeenCalled();
      expect(state.browserListeners.size).toBe(0);

      yield* Effect.promise(() =>
        act(async () => {
          state.allowed = true;
          for (const listener of state.permissionListeners) listener();
        }),
      );
      yield* Effect.all(state.streams.map(Stream.runDrain));
      expect(state.browserCommand).toHaveBeenCalledWith({
        desktopHostId: "host-remote",
        command: { type: "cdp", threadId: "thread-1", tabId: "tab-1", message: "page-command" },
      });
      const input: BrowserEventInput = {
        desktopHostId: "host-remote",
        event: { type: "cdp", threadId: "thread-1", tabId: "tab-1", message: "page-response" },
      };
      for (const listener of state.browserListeners) listener(input);
      expect(state.sendEvent).toHaveBeenCalledWith({ environmentId: remote, input });

      yield* Effect.promise(() =>
        act(async () => {
          state.allowed = false;
          for (const listener of state.permissionListeners) listener();
        }),
      );
      expect(state.browserCommand).toHaveBeenLastCalledWith({
        desktopHostId: "host-remote",
        command: { type: "disconnect" },
      });
      expect(state.browserListeners.size).toBe(0);
      state.sendEvent.mockClear();
      for (const listener of state.browserListeners) listener(input);
      expect(state.sendEvent).not.toHaveBeenCalled();
    }),
);
