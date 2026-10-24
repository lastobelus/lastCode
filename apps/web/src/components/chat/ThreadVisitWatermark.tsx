import { resolveThreadVisitDecision } from "../ChatView.logic";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";
import { useUiStateStore } from "../../uiStateStore";
import { threadEnvironment } from "../../state/threads";
import { useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";

// During an active turn the thread's updatedAt advances several times per
// second, and every server-side visit is a full command dispatch plus a
// broadcast to all shell subscribers.
const VISIT_DISPATCH_THROTTLE_MS = 10_000;

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. Keeping it in a leaf lets
// ChatView read the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  const serverThread = useThreadShell(props.threadRef);
  const threadKey = scopedThreadKey(props.threadRef);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLocalLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[threadKey],
  );
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const lastDispatchedVisitRef = useRef<string | null>(null);
  const lastObservedVisitRef = useRef<{ threadKey: string; visitedAt: number } | null>(null);
  const lastVisitDispatchAtRef = useRef(0);

  useEffect(() => {
    if (!serverThread?.id) {
      lastObservedVisitRef.current = null;
      lastDispatchedVisitRef.current = resolveThreadVisitDecision(
        NaN,
        NaN,
        null,
        lastDispatchedVisitRef.current,
      ).nextKey;
      return;
    }
    const threadUpdatedAt = Date.parse(serverThread.updatedAt);
    const effectiveLastVisitedAt = resolveThreadLastVisitedAt(
      serverThread.lastVisitedAt,
      activeThreadLocalLastVisitedAt,
    );
    const lastVisitedAt = effectiveLastVisitedAt ? Date.parse(effectiveLastVisitedAt) : NaN;
    const dispatchKey = `${threadKey}:${serverThread.updatedAt}`;
    const previousVisit = lastObservedVisitRef.current;
    const rewound =
      previousVisit?.threadKey === threadKey && lastVisitedAt < previousVisit.visitedAt;
    lastObservedVisitRef.current = { threadKey, visitedAt: lastVisitedAt };
    const visitDecision = resolveThreadVisitDecision(
      threadUpdatedAt,
      lastVisitedAt,
      dispatchKey,
      lastDispatchedVisitRef.current,
      rewound,
    );
    if (!visitDecision.record) {
      lastDispatchedVisitRef.current = visitDecision.nextKey;
      return;
    }

    if (serverThread.lastVisitedAt !== undefined) {
      const dispatch = () => {
        lastDispatchedVisitRef.current = dispatchKey;
        lastVisitDispatchAtRef.current = Date.now();
        void visitThreadMutation({
          environmentId: serverThread.environmentId,
          input: { threadId: serverThread.id, visitedAt: serverThread.updatedAt },
        });
      };
      const latestRunCompletedAtMs = serverThread.latestRun?.completedAt
        ? Date.parse(serverThread.latestRun.completedAt)
        : NaN;
      const hasUnseenCompletion =
        !Number.isNaN(latestRunCompletedAtMs) &&
        (Number.isNaN(lastVisitedAt) || latestRunCompletedAtMs > lastVisitedAt);
      const elapsed = Date.now() - lastVisitDispatchAtRef.current;
      if (hasUnseenCompletion || elapsed >= VISIT_DISPATCH_THROTTLE_MS) {
        dispatch();
        return;
      }
      const timer = setTimeout(dispatch, VISIT_DISPATCH_THROTTLE_MS - elapsed);
      return () => clearTimeout(timer);
    }

    lastDispatchedVisitRef.current = visitDecision.nextKey;
    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      serverThread.updatedAt,
    );
  }, [
    activeThreadLocalLastVisitedAt,
    markThreadVisited,
    threadKey,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.lastVisitedAt,
    serverThread?.latestRun?.completedAt,
    serverThread?.updatedAt,
    visitThreadMutation,
  ]);
  return null;
}
