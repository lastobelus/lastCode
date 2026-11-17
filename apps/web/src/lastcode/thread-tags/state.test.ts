import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  type ThreadTagVocabularyInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/shell", () => ({
  environmentShell: {
    stateValueAtom: Atom.family(() =>
      Atom.make({ generation: 1, removedAt: new Map<string, number>(), snapshot: Option.none() }),
    ),
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: {
    anyEnvironmentHidingAtom: Atom.make(false),
    hiddenThreadKeysAtom: Atom.make<ReadonlySet<string>>(new Set<string>()),
    threadRefsAtom: Atom.make([]),
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    hiddenThreadTagsAtom: Atom.family(() => Atom.make<readonly string[] | null>(null)),
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  createEnvironmentRpcQueryAtomFamily: () => ({}),
  createEnvironmentQueryAtomFamily: (
    _runtime: unknown,
    options: {
      execute: (input: ThreadTagVocabularyInput) => Effect.Effect<unknown>;
      refreshTrigger: (target: {
        environmentId: EnvironmentId;
        input: ThreadTagVocabularyInput;
      }) => Atom.Atom<unknown>;
    },
  ) => {
    const queries = Atom.family((key: string) => {
      const target = JSON.parse(key) as {
        environmentId: EnvironmentId;
        input: ThreadTagVocabularyInput;
      };
      return Atom.make((get) => {
        get(options.refreshTrigger(target));
        return options.execute(target.input);
      });
    });
    return (target: unknown) => queries(JSON.stringify(target));
  },
}));
vi.mock("@t3tools/client-runtime/rpc", () => ({ request: vi.fn() }));

import { request } from "@t3tools/client-runtime/rpc";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { vocabularyScope } from "./state";

it.effect(
  "reuses complete vocabulary by scope, invalidating on stream metadata and privacy changes",
  () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const set = <A>(atom: Atom.Atom<A>, value: A) =>
        registry.set(atom as Atom.Writable<A>, value);
      try {
        let reads = 0;
        vi.mocked(request).mockImplementation(
          (_method, input) =>
            Effect.sync(() => {
              reads++;
              const hidden = (input as ThreadTagVocabularyInput).uiVisibility?.hiddenTags !== null;
              const entries = [
                { tag: "Work/Client", count: 2, projectCount: 1, preferredProject: true },
                ...(hidden ? [] : [{ tag: "WC", count: 3, projectCount: 1 }]),
              ];
              const cursor = (input as ThreadTagVocabularyInput).cursor ?? 0;
              return {
                entries: entries.slice(cursor, cursor + 1),
                nextCursor: cursor + 1 < entries.length ? cursor + 1 : null,
              };
            }) as ReturnType<typeof request>,
        );
        const environmentId = EnvironmentId.make("local");
        const base = { preferredProjectId: ProjectId.make("project") };
        const read = (input: ThreadTagVocabularyInput) =>
          AtomRegistry.getResult(
            registry,
            vocabularyScope(JSON.stringify({ environmentId, input })),
            {
              suspendOnWaiting: true,
            },
          );
        expect((yield* read(base)).entries.map((entry) => entry.tag)).toEqual([
          "Work/Client",
          "WC",
        ]);
        yield* read(base);
        expect(reads).toBe(2);
        set(environmentShell.stateValueAtom(environmentId), {
          ...registry.get(environmentShell.stateValueAtom(environmentId)),
          generation: 2,
        });
        yield* read(base);
        expect(reads).toBe(4);
        set(serverEnvironment.hiddenThreadTagsAtom(environmentId), ["private"]);
        set(environmentThreadShells.anyEnvironmentHidingAtom, true);
        set(
          environmentThreadShells.hiddenThreadKeysAtom,
          new Set([`${environmentId}\u0000${ThreadId.make("private")}`]),
        );
        expect((yield* read(base)).entries.map((entry) => entry.tag)).toEqual(["Work/Client"]);
        expect(reads).toBeGreaterThan(4);
      } finally {
        registry.dispose();
      }
    }),
);
