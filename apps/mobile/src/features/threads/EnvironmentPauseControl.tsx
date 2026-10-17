import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EnvironmentPauseStatus } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { environmentPause, environmentPauseConnectionsAtom } from "../../state/environment-pause";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  environmentPauseAvailability,
  environmentPauseBlockerLabel,
} from "./environment-pause-model";

export function useEnvironmentPauseControl(environmentId: EnvironmentId) {
  const targets = useAtomValue(environmentPauseConnectionsAtom);
  const target = targets.find((candidate) => candidate.environmentId === environmentId);
  const [open, setOpen] = useState(false);
  const entryAtom = useMemo(
    () =>
      Atom.make((get) => {
        if (!target) return null;
        const request = { environmentId, input: {} };
        const config = get(serverEnvironment.configValueAtom(environmentId));
        const supported = config?.environment.capabilities.environmentPause === true;
        const initial = supported
          ? get(environmentPause.monitorStatus(request))
          : AsyncResult.initial<EnvironmentPauseStatus>();
        const saved = Option.getOrNull(AsyncResult.value(initial));
        const result =
          supported && target.connected && open
            ? get(environmentPause.activeStatus(request))
            : initial;
        const status = Option.getOrNull(AsyncResult.value(result)) ?? saved;
        const enabled = supported && config.settings.environmentPauseEnabled === true;
        return {
          ...target,
          status,
          availability: environmentPauseAvailability({
            enabled,
            connected: target.connected,
            fresh: AsyncResult.isSuccess(result) && result.timestamp >= target.since,
            status,
          }),
          queryFailed: AsyncResult.isFailure(result),
          canStart: get(environmentPause.start.permissionAtom(environmentId)),
          canRetry: get(environmentPause.retry.permissionAtom(environmentId)),
          canResume: get(environmentPause.resume.permissionAtom(environmentId)),
        };
      }),
    [environmentId, open, target],
  );
  const entry = useAtomValue(entryAtom);
  const onPress = useCallback(() => setOpen(true), []);
  return {
    visible: entry?.availability.visible ?? false,
    hasSession: entry?.status?.session != null,
    environmentLabel: entry?.environmentLabel ?? "Environment",
    onPress,
    modal:
      open && entry ? <EnvironmentPauseModal entry={entry} onClose={() => setOpen(false)} /> : null,
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
            label={`${control.hasSession ? "Resume" : "Pause"} ${control.environmentLabel}`}
            tone="secondary"
            onPress={control.onPress}
          />
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
  readonly canStart: boolean;
  readonly canRetry: boolean;
  readonly canResume: boolean;
};

function EnvironmentPauseModal(props: {
  readonly entry: PauseEntry;
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
            onClose={props.onClose}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

function EnvironmentPauseDetails(props: {
  readonly entry: PauseEntry;
  readonly onClose: () => void;
}) {
  const { entry } = props;
  const start = useAtomCommand(environmentPause.start, { reportFailure: false });
  const retry = useAtomCommand(environmentPause.retry, { reportFailure: false });
  const resume = useAtomCommand(environmentPause.resume, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const session = entry.status?.session ?? null;
  const availability = entry.availability;
  const run = async (action: "start" | "retry" | "resume" | "cancel") => {
    if (pendingRef.current) return;
    if (action === "start" && (!entry.canStart || !availability.canStart)) return;
    if (action === "retry" && (!entry.canRetry || !availability.canRetryPause)) return;
    if (action === "resume" && (!entry.canResume || !availability.canResume)) return;
    if (action === "cancel" && (!entry.canResume || !availability.canCancelPause)) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const command = action === "start" ? start : action === "retry" ? retry : resume;
      const result = await command({ environmentId: entry.environmentId, input: {} });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      if (action === "resume" || action === "cancel") setResumed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const working = session !== null && !availability.ready && availability.known;
  return (
    <>
      <Text accessibilityRole="header" className="text-xl font-t3-semibold">
        {entry.environmentLabel}
      </Text>
      {resumed && session === null ? (
        <Text className="text-base text-foreground-secondary">Pause session finished.</Text>
      ) : !availability.known ? (
        <Text accessibilityRole="alert" className="text-base text-foreground-secondary">
          {!entry.connected
            ? "Reconnect to check whether all work is quiet."
            : entry.queryFailed
              ? "Could not check the environment. Reconnect or try again."
              : "Checking the environment…"}
        </Text>
      ) : session === null ? (
        <Text className="text-base text-foreground-secondary">
          Send “pause to go offline” to every active thread in this environment, then wait until all
          environment work is quiet. Automatic thread wake-ups will wait until you resume, even if
          the environment reconnects.
        </Text>
      ) : session.phase === "resuming" ? (
        <View className="flex-row items-center gap-3">
          {session.targets.some(
            (target) => target.pause === "sent" && target.resume === "pending",
          ) ? (
            <AppActivityIndicator accessibilityLabel="Resuming paused threads" />
          ) : null}
          <Text className="flex-1 text-base text-foreground-secondary">
            Resuming the original paused threads. Automatic thread wake-ups are enabled; held work
            will continue as threads become available.
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
            {session.targets.length} {session.targets.length === 1 ? "thread" : "threads"} tracked.
            Resume sends “resume” to the threads that received the pause message.
          </Text>
          {session.phase !== "resuming" ? (
            <Text className="text-sm text-foreground-muted">
              Automatic thread wake-ups are held until you resume.
            </Text>
          ) : null}
          {availability.showCancelPause ? (
            <Text className="text-sm text-foreground-muted">
              Cancel pause resumes those threads so you can deal with unfinished work.
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
            .filter((target) => target.pause === "failed" || target.resume === "failed")
            .map((target) => (
              <Text key={target.threadId} selectable className="text-sm text-danger-foreground">
                {target.title}: {target.error ?? "Message could not be sent."}
              </Text>
            ))}
          {session.targets
            .filter(
              (target) =>
                target.pause === "unavailable" ||
                (session.phase === "resuming" && target.resume === "unavailable"),
            )
            .map((target) => (
              <Text key={target.threadId} className="text-sm text-foreground-muted">
                {target.title}: Archived or deleted threads cannot receive{" "}
                {session.phase === "resuming" ? "resume" : "pause"} requests.
              </Text>
            ))}
        </>
      ) : null}
      {error ? (
        <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap justify-end gap-3">
        <Button label="Close" tone="secondary" onPress={props.onClose} />
        {resumed && session === null ? null : session === null ? (
          <Button
            label={pending ? "Pausing…" : "Pause to go offline"}
            tone="primary"
            disabled={pending || !entry.canStart || !availability.canStart}
            onPress={() => void run("start")}
          />
        ) : (
          <>
            {availability.showPauseAgain ? (
              <Button
                label={pending ? "Pausing…" : "Pause again"}
                tone="primary"
                disabled={pending || !entry.canStart || !availability.canPauseAgain}
                onPress={() => void run("start")}
              />
            ) : null}
            {availability.showRetryPause ? (
              <Button
                label={availability.pauseFailed ? "Retry pause" : "Pause remaining threads"}
                tone="secondary"
                disabled={pending || !entry.canRetry || !availability.canRetryPause}
                onPress={() => void run("retry")}
              />
            ) : null}
            {availability.showCancelPause ? (
              <Button
                label={pending ? "Sending…" : "Cancel pause"}
                tone="secondary"
                disabled={pending || !entry.canResume || !availability.canCancelPause}
                onPress={() => void run("cancel")}
              />
            ) : null}
            {availability.ready ||
            (session.phase === "resuming" && !availability.showPauseAgain) ? (
              <Button
                label={
                  pending ? "Sending…" : session.phase === "resuming" ? "Retry resume" : "Resume"
                }
                tone="primary"
                disabled={pending || !entry.canResume || !availability.canResume}
                onPress={() => void run("resume")}
              />
            ) : null}
          </>
        )}
      </View>
    </>
  );
}
