import { RegistryContext } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { hiddenThreadKeys } from "@t3tools/shared/threadTags";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../../../connection/runtime", () => ({
  connectionAtomRuntime: Atom.runtime(Layer.empty),
}));
vi.mock("../../../state/preferences", () => ({ mobilePreferencesAtom: Atom.make({}) }));
vi.mock("../../../state/shell", () => ({
  environmentShell: {
    stateValueAtom: Atom.family(() =>
      Atom.make({ generation: 1, removedAt: new Map(), snapshot: Option.none() }),
    ),
  },
}));
vi.mock("../../../state/threads", () => ({
  environmentThreadShells: {
    hiddenThreadKeysAtom: Atom.make<ReadonlySet<string>>(new Set<string>()),
    anyEnvironmentHidingAtom: Atom.make(false),
    threadRefsAtom: Atom.make<readonly ScopedThreadRef[]>([]),
  },
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: {
    hiddenThreadTagsAtom: Atom.family(() => Atom.make<readonly string[] | null>(null)),
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  createEnvironmentQueryAtomFamily: () => () => Atom.make(AsyncResult.initial()),
  runAtomCommand: vi.fn(),
  squashAtomCommandFailure: () => new Error("Unavailable"),
}));

import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { makeRawThreadShell } from "../../../test-fixtures";
import { environmentThreadShells } from "../../../state/threads";
import { serverEnvironment } from "../../../state/server";
import { useTagDiscovery } from "./state";

it.each(["tag", "parent"] as const)(
  "withholds cached mobile tag results while a %s visibility refresh is held or fails",
  async (change) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const environmentId = EnvironmentId.make("test-environment");
    const parent = makeRawThreadShell({ id: ThreadId.make("parent"), tags: ["private"] });
    const thread = makeRawThreadShell({
      id: ThreadId.make("result"),
      tags: ["Work", "private"],
      ...(change === "parent"
        ? {
            tags: ["Work"],
            lineage: {
              parentThreadId: parent.id,
              rootThreadId: parent.id,
              relationshipToParent: "subagent" as const,
            },
          }
        : {}),
    });
    const registry = AtomRegistry.make();
    const set = <A,>(atom: Atom.Atom<A>, value: A) => registry.set(atom as Atom.Writable<A>, value);
    set(environmentThreadShells.hiddenThreadKeysAtom, new Set<string>());
    set(environmentThreadShells.anyEnvironmentHidingAtom, false);
    set(serverEnvironment.hiddenThreadTagsAtom(environmentId), null);
    set(environmentThreadShells.threadRefsAtom, [
      { environmentId, threadId: parent.id },
      { environmentId, threadId: thread.id },
    ]);
    const root = createRoot(document.createElement("div"));
    using _cleanup = {
      [Symbol.dispose]() {
        act(() => root.unmount());
        registry.dispose();
      },
    };
    let current: ReturnType<typeof useTagDiscovery> | undefined;
    function Probe() {
      const result = useTagDiscovery([{ environmentId }], "", "Work");
      useLayoutEffect(() => {
        current = result;
      });
      return null;
    }
    vi.mocked(runAtomCommand).mockReset();
    vi.mocked(runAtomCommand).mockResolvedValue(
      AsyncResult.success({ threads: [thread], nextCursor: null }),
    );
    await act(async () => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      );
    });
    expect(current?.threads.map((row) => row.id)).toEqual([thread.id]);

    const refresh = Promise.withResolvers<Awaited<ReturnType<typeof runAtomCommand>>>();
    const requested = Promise.withResolvers<void>();
    vi.mocked(runAtomCommand).mockImplementation(() => {
      requested.resolve();
      return refresh.promise;
    });
    await act(async () => {
      set(serverEnvironment.hiddenThreadTagsAtom(environmentId), ["private"]);
      set(environmentThreadShells.anyEnvironmentHidingAtom, true);
      if (change === "parent") {
        const hidden = hiddenThreadKeys([
          { environmentId, threads: [parent], hiddenTags: ["private"] },
        ]);
        expect(hidden.has(threadKey({ environmentId, threadId: parent.id }))).toBe(true);
        set(environmentThreadShells.hiddenThreadKeysAtom, hidden);
      }
      await requested.promise;
    });
    expect(current?.loading).toBe(true);
    expect(current?.threads).toEqual([]);
    await act(async () => {
      refresh.resolve(AsyncResult.fail(new Error("Connection unavailable")));
    });
    expect(current?.threads).toEqual([]);
    expect(current?.error).not.toBeNull();
  },
);
