import { useAtomValue } from "@effect/atom-react";
import {
  actionResumeEnvironmentPaused,
  actionResumeWait,
} from "@t3tools/client-runtime/state/action-resume";
import type {
  ActionResumeState,
  EnvironmentId,
  EnvironmentPauseStatus,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironment } from "./environments";
import { environmentPause, environmentPauseConnectionsAtom } from "./environmentPause";
import { environmentThreadDetails } from "./threads";

const EMPTY_PAUSE_STATUS = Atom.make(AsyncResult.initial<EnvironmentPauseStatus>());

export function useActionEnvironmentPause(environmentId: EnvironmentId) {
  const environment = useEnvironment(environmentId);
  const connections = useAtomValue(environmentPauseConnectionsAtom);
  const connection = connections.find((candidate) => candidate.environmentId === environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.environmentPause === true;
  const query = supported
    ? environmentPause.monitorStatus({ environmentId, input: {} })
    : EMPTY_PAUSE_STATUS;
  const result = useAtomValue(query);
  const status = Option.getOrNull(AsyncResult.value(result));
  const connected = connection?.connected === true && environment?.serverConfig != null;
  const known = !supported
    ? environment?.serverConfig != null
    : AsyncResult.isSuccess(result) &&
      connection !== undefined &&
      result.timestamp >= connection.since &&
      status?.observation === "known";
  return {
    environment,
    known: connected && known,
    phase: status?.session?.phase ?? null,
    paused: actionResumeEnvironmentPaused({ connected, supported, known, status }),
  };
}

export function useActionResumeWait(ref: ScopedThreadRef, action: ActionResumeState | null) {
  const context = useAtomValue(environmentThreadDetails.actionResumeContextAtom(ref));
  const { paused } = useActionEnvironmentPause(ref.environmentId);
  return actionResumeWait(context, action, paused);
}
