import {
  recordServerBrowserHandoff,
  forgetServerBrowserHandoff,
} from "~/components/preview/serverBrowserHandoff";
import { useAtomMount } from "@effect/atom-react";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import { createEnvironmentSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  ThreadId,
  WS_METHODS,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { useEffect } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentScope } from "~/state/session";
import { useEnvironmentHasLocalDesktopBrowser } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  applyPreviewServerEvent,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
} from "~/previewStateStore";
import { getDesktopBrowserHostId, resolveDesktopBrowserUrl } from "./desktopBrowserTransport";

const commands = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "desktop-browser:commands",
  idleTtlMs: 0,
  subscribe: (input: { desktopHostId: string; environmentId: EnvironmentId }) =>
    subscribe(WS_METHODS.subscribeDesktopBrowserCommands, {
      desktopHostId: input.desktopHostId,
    }).pipe(
      Stream.mapEffect((command) =>
        command.type === "resolveUrl"
          ? request(WS_METHODS.desktopBrowserEvent, {
              desktopHostId: input.desktopHostId,
              event: {
                type: "resolvedUrl",
                requestId: command.requestId,
                url: resolveDesktopBrowserUrl(input.environmentId, command.url),
              },
            })
          : Effect.promise(() =>
              window.desktopBridge!.preview!.browserCommand({
                desktopHostId: input.desktopHostId,
                command,
              }),
            ),
      ),
    ),
});

const previewEvents = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "desktop-browser:preview-events",
  idleTtlMs: 0,
  subscribe: ({
    environmentId,
    applyEvents,
  }: {
    environmentId: EnvironmentId;
    applyEvents: boolean;
  }) =>
    subscribe(WS_METHODS.subscribePreviewEvents, {}).pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function* () {
          const ref = { environmentId, threadId: ThreadId.make(event.threadId) };
          // The root host owns its primary server's state; relayed environments
          // still sync here while their chat views are unmounted.
          if (applyEvents) {
            const epoch = readThreadPreviewState(ref).serverEpoch;
            if (epoch !== null && epoch !== event.serverEpoch) {
              const sessions = yield* request(WS_METHODS.previewList, { threadId: ref.threadId });
              reconcilePreviewServerSessions(ref, sessions);
            }
            applyPreviewServerEvent(ref, event);
          }
          if ("snapshot" in event) void recordServerBrowserHandoff(ref, event.snapshot);
          else if (event.type === "closed") forgetServerBrowserHandoff(ref, event.tabId);
        }),
      ),
    ),
});

function PreviewEventsRelay({
  environmentId,
  applyEvents,
}: {
  environmentId: EnvironmentId;
  applyEvents: boolean;
}) {
  useAtomMount(previewEvents({ environmentId, input: { environmentId, applyEvents } }));
  return null;
}

function EnvironmentRelay({ environmentId }: { environmentId: EnvironmentId }) {
  const desktopHostId = getDesktopBrowserHostId(environmentId);
  const sendEvent = useAtomCommand(previewEnvironment.browserEvent, {
    reportFailure: false,
    reportDefect: true,
  });
  // Listen before the command subscription requests the native tab announcement.
  useEffect(() => {
    const bridge = window.desktopBridge!.preview!;
    const unsubscribe = bridge.onBrowserEvent((input) => {
      if (input.desktopHostId === desktopHostId) void sendEvent({ environmentId, input });
    });
    return () => {
      unsubscribe();
      void bridge
        .browserCommand({ desktopHostId, command: { type: "disconnect" } })
        .catch(() => undefined);
    };
  }, [desktopHostId, environmentId, sendEvent]);
  useAtomMount(commands({ environmentId, input: { desktopHostId, environmentId } }));
  return null;
}

function AuthorizedEnvironmentRelay({ environmentId }: { environmentId: EnvironmentId }) {
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  return canOperatePreview ? <EnvironmentRelay environmentId={environmentId} /> : null;
}

/** Only forwards native CDP frames; all automation runs in ServerBrowser. */
export function DesktopCdpRelay() {
  const environments = useConnectedEnvironmentIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hasLocalDesktopBrowser = useEnvironmentHasLocalDesktopBrowser(primaryEnvironmentId);
  if (!window.desktopBridge?.preview) return null;
  return (
    <>
      {environments.map((environmentId) => (
        <PreviewEventsRelay
          key={environmentId}
          environmentId={environmentId}
          applyEvents={environmentId !== primaryEnvironmentId}
        />
      ))}
      {environments
        .filter((id) => id !== primaryEnvironmentId || hasLocalDesktopBrowser === false)
        .map((environmentId) => (
          <AuthorizedEnvironmentRelay key={environmentId} environmentId={environmentId} />
        ))}
    </>
  );
}
