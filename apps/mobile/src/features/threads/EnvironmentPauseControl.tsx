import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EnvironmentPauseStatus } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { environmentPauseBlockerLabel } from "@t3tools/shared/actionResume";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { environmentPause, environmentPauseConnectionsAtom } from "../../state/environment-pause";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentPauseAvailability } from "./environment-pause-model";

export function useEnvironmentPauseControl(environmentId: EnvironmentId) {
  const targets = useAtomValue(environmentPauseConnectionsAtom);
  const target = targets.find((candidate) => candidate.environmentId === environmentId);
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<{ environmentId: EnvironmentId; message: string } | null>(
    null,
  );
  const error = failure?.environmentId === environmentId ? failure.message : null;
  const requestVersion = useRef(0);
  const start = useAtomCommand(environmentPause.start, { reportFailure: false });
  const resume = useAtomCommand(environmentPause.resume, { reportFailure: false });
  const retry = useAtomCommand(environmentPause.retry, { reportFailure: false });
  const entryAtom = useMemo(
    () =>
      Atom.make((get) => {
        if (!target) return null;
        const request = { environmentId, input: {} };
        const config = get(serverEnvironment.configValueAtom(environmentId));
        const supported = config?.environment.capabilities.environmentPause === true;
        const result = supported
          ? get(
              (open && target.connected
                ? environmentPause.activeStatus
                : environmentPause.monitorStatus)(request),
            )
          : AsyncResult.initial<EnvironmentPauseStatus>();
        const status = Option.getOrNull(AsyncResult.value(result));
        const enabled = supported && config.settings.environmentPauseEnabled === true;
        return {
          ...target,
          status,
          availability: environmentPauseAvailability({
            enabled,
            connected: target.connected,
            fresh: AsyncResult.isSuccess(result) && result.timestamp >= target.since,
            intent: get(environmentPause.intent(environmentId)),
            status,
          }),
          queryFailed: AsyncResult.isFailure(result),
          canStart: get(environmentPause.start.permissionAtom(environmentId)),
          canResume: get(environmentPause.resume.permissionAtom(environmentId)),
          canRetry: get(environmentPause.retry.permissionAtom(environmentId)),
        };
      }),
    [environmentId, open, target],
  );
  const entry = useAtomValue(entryAtom);
  const onPress = useCallback(() => setOpen(true), []);
  const primaryAction = entry?.availability.primaryAction ?? "start";
  const disabled =
    !entry ||
    (primaryAction === "resume"
      ? !entry.canResume || !entry.availability.canResume
      : !entry.canStart || !entry.availability.canStart);
  const execute = async (action: "start" | "resume" | "retry") => {
    if (
      !entry ||
      (action === "retry"
        ? !entry.canRetry || !entry.availability.canRetryPause
        : action === "resume"
          ? !entry.canResume || !entry.availability.canResume
          : !entry.canStart || !entry.availability.canStart)
    )
      return;
    const version = ++requestVersion.current;
    setFailure(null);
    const result = await (action === "retry" ? retry : action === "resume" ? resume : start)({
      environmentId,
      input: {},
    });
    if (version === requestVersion.current && AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setFailure({
        environmentId,
        message: cause instanceof Error ? cause.message : "The request failed. Try again.",
      });
    }
  };
  return {
    visible: entry?.availability.visible ?? false,
    primaryAction,
    disabled,
    error,
    environmentLabel: entry?.environmentLabel ?? "Environment",
    onPress,
    onToggle: () => void execute(primaryAction),
    modal:
      open && entry ? (
        <EnvironmentPauseModal
          entry={entry}
          error={error}
          onResume={() => void execute("resume")}
          onRetry={() => void execute("retry")}
          onClose={() => setOpen(false)}
        />
      ) : null,
  };
}

/** Pause controls always belong to the environment named on the connection card. */
export function EnvironmentPauseControl(props: { readonly environmentId: EnvironmentId }) {
  const control = useEnvironmentPauseControl(props.environmentId);
  return (
    <>
      {control.visible ? (
        <View className="items-start px-4 pb-3">
          <Button
            label={`${control.primaryAction === "resume" ? "Resume" : "Pause"} ${control.environmentLabel}`}
            tone="secondary"
            disabled={control.disabled}
            onPress={control.onToggle}
          />
          {control.error ? (
            <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
              {control.error}
            </Text>
          ) : null}
        </View>
      ) : null}
      {control.modal}
    </>
  );
}

type PauseEntry = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly status: EnvironmentPauseStatus | null;
  readonly availability: ReturnType<typeof environmentPauseAvailability>;
  readonly queryFailed: boolean;
  readonly canResume: boolean;
  readonly canRetry: boolean;
};

function EnvironmentPauseModal(props: {
  readonly entry: PauseEntry;
  readonly error: string | null;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <View className="flex-1 items-center justify-center bg-backdrop px-6">
        <ScrollView
          className="max-h-[80%] w-full max-w-md grow-0 rounded-3xl bg-screen"
          contentContainerStyle={{ padding: 24, gap: 20 }}
        >
          <EnvironmentPauseDetails
            key={props.entry.environmentId}
            entry={props.entry}
            error={props.error}
            onResume={props.onResume}
            onRetry={props.onRetry}
            onClose={props.onClose}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

function EnvironmentPauseDetails(props: {
  readonly entry: PauseEntry;
  readonly error: string | null;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  const { entry } = props;
  const session = entry.status?.session ?? null;
  const availability = entry.availability;
  const working = session !== null && !availability.ready && availability.known;
  return (
    <>
      <Text accessibilityRole="header" className="text-xl font-t3-semibold">
        {entry.environmentLabel}
      </Text>
      {availability.known && !availability.hasSession ? (
        <Text className="text-base text-foreground-secondary">Not paused.</Text>
      ) : !availability.known ? (
        <Text accessibilityRole="alert" className="text-base text-foreground-secondary">
          {!entry.connected
            ? "Reconnect to check whether all work is quiet."
            : entry.queryFailed
              ? "Could not check the environment. Reconnect or try again."
              : "Checking the environment…"}
        </Text>
      ) : session?.phase === "resuming" ? (
        <View className="flex-row items-center gap-3">
          {session.targets.some(
            (target) => target.pause === "sent" && target.resume === "pending",
          ) ? (
            <AppActivityIndicator accessibilityLabel="Resuming paused threads" />
          ) : null}
          <Text className="flex-1 text-base text-foreground-secondary">
            Sending “resume” to the threads that received Pause. Automatic thread wake-ups are back
            on.
          </Text>
        </View>
      ) : availability.ready ? (
        <Text accessibilityRole="alert" className="text-base font-t3-medium text-foreground">
          All work is quiet. Ready to go offline.
        </Text>
      ) : (
        <View className="flex-row items-center gap-3">
          {working ? (
            <AppActivityIndicator accessibilityLabel="Waiting for environment work to finish" />
          ) : null}
          <Text
            accessibilityLiveRegion="polite"
            className="flex-1 text-base text-foreground-secondary"
          >
            {entry.status?.activeThreadCount ?? 0} active{" "}
            {entry.status?.activeThreadCount === 1 ? "thread" : "threads"} remaining
          </Text>
        </View>
      )}
      {session && availability.known ? (
        <>
          <Text className="text-sm text-foreground-muted">
            {session.targets.length} {session.targets.length === 1 ? "thread" : "threads"} in this
            pause. You can resume at any time; only threads that got the pause message receive
            “resume”.
          </Text>
          {session.phase !== "resuming" ? (
            <Text className="text-sm text-foreground-muted">
              Automatic thread wake-ups are held until you resume.
            </Text>
          ) : null}
          {entry.status?.blockers.map((blocker) => {
            const target =
              "threadId" in blocker
                ? session.targets.find((candidate) => candidate.threadId === blocker.threadId)
                : null;
            return (
              <Text key={JSON.stringify(blocker)} className="text-sm text-foreground-secondary">
                {environmentPauseBlockerLabel(blocker)}
                {target ? ` · ${target.title}` : ""}
              </Text>
            );
          })}
          {session.targets
            .filter((target) =>
              session.phase === "resuming" ? target.resume === "failed" : target.pause === "failed",
            )
            .map((target) => (
              <Text key={target.threadId} selectable className="text-sm text-danger-foreground">
                {target.title}: {target.error ?? "Message not delivered."}
              </Text>
            ))}
          {session.targets
            .filter((target) =>
              session.phase === "resuming"
                ? target.resume === "unavailable"
                : target.pause === "unavailable",
            )
            .map((target) => (
              <Text key={target.threadId} className="text-sm text-foreground-muted">
                {target.title}: {target.error ?? "Thread unavailable"}
              </Text>
            ))}
        </>
      ) : null}
      {props.error ? (
        <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap justify-end gap-3">
        <Button label="Close" tone="secondary" onPress={props.onClose} />
        {availability.showRetryPause ? (
          <Button
            label={entry.availability.pauseFailed ? "Retry pause" : "Pause remaining threads"}
            tone="secondary"
            disabled={!entry.canRetry || !availability.canRetryPause}
            onPress={props.onRetry}
          />
        ) : null}
        {availability.hasSession ? (
          <Button
            label="Resume"
            tone="primary"
            disabled={!entry.canResume || !availability.canResume}
            onPress={props.onResume}
          />
        ) : null}
      </View>
    </>
  );
}
