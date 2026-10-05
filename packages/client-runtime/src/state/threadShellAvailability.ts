import type { OrchestrationV2ShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { type Atom, AtomRegistry } from "effect/unstable/reactivity";

/** A launch receipt can arrive before the shell stream; routes require the shell to exist. */
export function awaitThreadShell(
  registry: AtomRegistry.AtomRegistry,
  snapshot: Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  threadId: ThreadId,
) {
  return AtomRegistry.toStream(registry, snapshot).pipe(
    Stream.filter(
      (value) =>
        value?.threads.some((thread) => thread.id === threadId && thread.deletedAt === null) ===
        true,
    ),
    Stream.runHead,
    Effect.timeoutOption("10 seconds"),
    Effect.map(Option.flatten),
    Effect.flatMap(
      Option.match({
        onSome: () => Effect.void,
        onNone: () =>
          Effect.fail(
            new Error(
              "The repair thread was created, but its details have not arrived yet. Open the repair thread again once this environment reconnects.",
            ),
          ),
      }),
    ),
  );
}
