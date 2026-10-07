import {
  AuthPreviewOperateScope,
  EnvironmentId,
  WS_METHODS,
  type AuthEnvironmentScope,
  DesktopBrowserEventInput,
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
vi.mock("~/previewStateStore", () => ({}));
vi.mock("~/components/preview/serverBrowserHandoff", () => ({}));
vi.mock("./desktopBrowserTransport", () => ({
  getDesktopBrowserHostId: (environmentId: EnvironmentId) => `host-${environmentId}`,
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({
  subscribe: (method: string) =>
    method === WS_METHODS.subscribeDesktopBrowserCommands
      ? Stream.fromIterable([
          { type: "cdp", threadId: "thread-1", tabId: "tab-1", message: "page-command" },
        ])
      : Stream.empty,
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
