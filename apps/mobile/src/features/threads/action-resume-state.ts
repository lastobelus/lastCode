import { useAtomValue } from "@effect/atom-react";
import {
  actionResumeEnvironmentPaused,
  actionResumeWait,
  type ActionResumeContext,
} from "@t3tools/client-runtime/state/action-resume";
import type {
  ActionResumeState,
  EnvironmentId,
  EnvironmentPauseStatus,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironmentServerConfig } from "../../state/entities";
import { environmentPause, environmentPauseConnectionsAtom } from "../../state/environment-pause";
import { environmentThreadDetails } from "../../state/threads";

const EMPTY_PAUSE_STATUS = Atom.make(AsyncResult.initial<EnvironmentPauseStatus>());
const EMPTY_ACTION_CONTEXT = Atom.make<ActionResumeContext | null>(null);

export function useActionEnvironmentPause(environmentId: EnvironmentId) {
  const config = useEnvironmentServerConfig(environmentId);
  const connections = useAtomValue(environmentPauseConnectionsAtom);
  const target = connections.find((connection) => connection.environmentId === environmentId);
  const supported = config?.environment.capabilities.environmentPause === true;
  const query = useMemo(
    () =>
      supported ? environmentPause.monitorStatus({ environmentId, input: {} }) : EMPTY_PAUSE_STATUS,
    [environmentId, supported],
  );
  const result = useAtomValue(query);
  const status = Option.getOrNull(AsyncResult.value(result));
  const connected = target?.connected === true && config !== null;
  const known =
    connected &&
    (!supported ||
      (AsyncResult.isSuccess(result) &&
        result.timestamp >= target.since &&
        status?.observation === "known"));
  return {
    supported,
    known,
    phase: known && supported ? (status?.session?.phase ?? null) : null,
    paused: actionResumeEnvironmentPaused({ connected, supported, known, status }),
    showUnknown: !known && (config === null || supported || status?.session != null),
  };
}

export function useActionResumeWait(
  ref: ScopedThreadRef | null,
  action: ActionResumeState | null,
  paused: boolean | null,
) {
  const context = useAtomValue(
    ref === null || action === null
      ? EMPTY_ACTION_CONTEXT
      : environmentThreadDetails.actionResumeContextAtom(ref),
  );
  return actionResumeWait(context, action, paused);
}
