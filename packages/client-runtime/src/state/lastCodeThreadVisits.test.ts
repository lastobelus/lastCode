import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ThreadAnnotation,
} from "@t3tools/contracts";
import { isThreadAnnotationRevealUnseen } from "@t3tools/shared/threadAnnotation";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import type { VisitThreadInput } from "../operations/commands.ts";
import { createThreadVisitTracker, VISIT_DISPATCH_THROTTLE_MS } from "./threadVisits.ts";

it.each(["trigger", "manual"] as const)(
  "acknowledges a %s reveal before leaving an open thread with no completed run",
  (by) => {
    const original = "2026-01-01T00:00:00.000Z";
    const revealAt = "2026-01-01T00:00:05.000Z";
    vi.useFakeTimers({ now: Date.parse(original) });
    const registry = AtomRegistry.make();
    try {
      const environmentId = EnvironmentId.make("env-reveal");
      const id = ThreadId.make(by);
      const initial = {
        environmentId,
        id,
        updatedAt: original,
        latestRun: null,
        lastVisitedAt: null,
        annotation: null,
      };
      const shellAtom = Atom.make<
        Omit<typeof initial, "lastVisitedAt" | "annotation"> & {
          lastVisitedAt: string | null;
          annotation: ThreadAnnotation | null;
        }
      >(initial);
      const generation = Atom.make(1);
      const visits: VisitThreadInput[] = [];
      const tracker = createThreadVisitTracker({
        threadShellAtom: () => shellAtom,
        sessionGenerationAtom: () => generation,
        visit: {
          label: "test-reveal-visit",
          run: (_registry, value) => Effect.sync(() => void visits.push(value.input)),
        },
      });
      const unmount = registry.mount(tracker({ environmentId, threadId: id }));
      expect(visits).toEqual([{ threadId: id, visitedAt: original, opened: true }]);
      const annotation: ThreadAnnotation = {
        anchorMessageId: MessageId.make("anchor"),
        body: "Wait",
        createdAt: original,
        updatedAt: revealAt,
        resolvedAt: null,
        reveal: {
          at: revealAt,
          by,
          trigger: { id: CommandId.make("hide"), kind: "date", hiddenAt: original, at: revealAt },
        },
      };
      expect(isThreadAnnotationRevealUnseen(annotation, original)).toBe(true);
      registry.set(shellAtom, { ...initial, lastVisitedAt: original, annotation });
      expect(visits[1]).toEqual({ threadId: id, visitedAt: revealAt });
      registry.set(shellAtom, {
        ...initial,
        updatedAt: revealAt,
        lastVisitedAt: original,
        annotation,
      });
      unmount();
      vi.advanceTimersByTime(VISIT_DISPATCH_THROTTLE_MS);
      expect(visits).toHaveLength(2);
      expect(isThreadAnnotationRevealUnseen(annotation, visits[1]?.visitedAt)).toBe(false);
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  },
);
