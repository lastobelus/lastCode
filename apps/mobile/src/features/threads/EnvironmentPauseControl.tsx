import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EnvironmentPauseStatus } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { environmentPause, environmentPauseConnectionsAtom } from "../../state/environment-pause";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  environmentPauseAvailability,
  environmentPauseBlockerLabel,
} from "./environment-pause-model";

export function useEnvironmentPauseControl() {
  const targets = useAtomValue(environmentPauseConnectionsAtom);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const entriesAtom = useMemo(
    () =>
      Atom.make((get) =>
        targets.map((target) => {
          const request = { environmentId: target.environmentId, input: {} };
          const config = get(serverEnvironment.configValueAtom(target.environmentId));
          const supported = config?.environment.capabilities.environmentPause === true;
          const initial = supported
            ? get(environmentPause.monitorStatus(request))
            : AsyncResult.initial<EnvironmentPauseStatus>();
          const saved = Option.getOrNull(AsyncResult.value(initial));
          const polling =
            supported && target.connected && open && selectedId === target.environmentId;
          const result = polling ? get(environmentPause.activeStatus(request)) : initial;
          const latest = Option.getOrNull(AsyncResult.value(result));
          const status = latest ?? saved;
          const enabled = supported && config.settings.environmentPauseEnabled === true;
          const availability = environmentPauseAvailability({
            enabled,
            connected: target.connected,
            fresh: AsyncResult.isSuccess(result) && result.timestamp >= target.since,
            status,
          });
          return {
            ...target,
            status,
            availability,
            queryFailed: AsyncResult.isFailure(result),
            canStart: get(environmentPause.start.permissionAtom(target.environmentId)),
            canRetry: get(environmentPause.retry.permissionAtom(target.environmentId)),
            canResume: get(environmentPause.resume.permissionAtom(target.environmentId)),
          };
        }),
      ),
    [open, selectedId, targets],
  );
  const entries = useAtomValue(entriesAtom);
  const candidates = entries.filter((entry) => entry.availability.visible);
  const onPress = useCallback(() => {
    setSelectedId(candidates.length === 1 ? candidates[0]!.environmentId : null);
    setOpen(true);
  }, [candidates]);
  return {
    visible: candidates.length > 0,
    hasSession: entries.some(
      (entry) => entry.status?.session !== null && entry.status?.session !== undefined,
    ),
    onPress,
    modal: open ? (
      <EnvironmentPauseModal
        entries={entries.filter(
          (entry) => entry.availability.visible || entry.environmentId === selectedId,
        )}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onClose={() => setOpen(false)}
      />
    ) : null,
  };
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
  readonly entries: readonly PauseEntry[];
  readonly selectedId: EnvironmentId | null;
  readonly onSelect: (environmentId: EnvironmentId) => void;
  readonly onClose: () => void;
}) {
  const entry = props.entries.find((candidate) => candidate.environmentId === props.selectedId);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <View className="flex-1 items-center justify-center bg-backdrop px-6">
        <ScrollView
          className="max-h-[80%] w-full max-w-md grow-0 rounded-3xl bg-screen"
          contentContainerStyle={{ padding: 24, gap: 20 }}
        >
          {entry ? (
            <EnvironmentPauseDetails
              key={entry.environmentId}
              entry={entry}
              onClose={props.onClose}
            />
          ) : (
            <>
              <Text accessibilityRole="header" className="text-xl font-t3-semibold">
                Pause an environment
              </Text>
              <Text className="text-base text-foreground-secondary">
                Choose the environment to pause or resume.
              </Text>
              {props.entries.map((candidate) => (
                <Pressable
                  key={candidate.environmentId}
                  accessibilityRole="button"
                  accessibilityLabel={`${candidate.status?.session ? "Resume" : "Pause"} controls for ${candidate.environmentLabel}`}
                  className="min-h-12 justify-center rounded-xl bg-subtle px-4 py-3"
                  onPress={() => props.onSelect(candidate.environmentId)}
                >
                  <Text className="font-t3-medium">{candidate.environmentLabel}</Text>
                  <Text className="text-sm text-foreground-muted">
                    {candidate.status?.session
                      ? "Saved pause session"
                      : candidate.connected
                        ? "Connected"
                        : "Disconnected"}
                  </Text>
                </Pressable>
              ))}
              {props.entries.length === 0 ? <Text>No pause controls are enabled.</Text> : null}
              <ControlPill label="Close" variant="pill" onPress={props.onClose} />
            </>
          )}
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
            <ActivityIndicator accessibilityLabel="Resuming paused threads" />
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
            <ActivityIndicator accessibilityLabel="Waiting for environment work to finish" />
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
        <ControlPill label="Close" variant="pill" onPress={props.onClose} />
        {resumed && session === null ? null : session === null ? (
          <ControlPill
            label={pending ? "Pausing…" : "Pause to go offline"}
            variant="primary"
            disabled={pending || !entry.canStart || !availability.canStart}
            onPress={() => void run("start")}
          />
        ) : (
          <>
            {availability.showPauseAgain ? (
              <ControlPill
                label={pending ? "Pausing…" : "Pause again"}
                variant="primary"
                disabled={pending || !entry.canStart || !availability.canPauseAgain}
                onPress={() => void run("start")}
              />
            ) : null}
            {availability.showRetryPause ? (
              <ControlPill
                label={availability.pauseFailed ? "Retry pause" : "Pause remaining threads"}
                variant="pill"
                disabled={pending || !entry.canRetry || !availability.canRetryPause}
                onPress={() => void run("retry")}
              />
            ) : null}
            {availability.showCancelPause ? (
              <ControlPill
                label={pending ? "Sending…" : "Cancel pause"}
                variant="pill"
                disabled={pending || !entry.canResume || !availability.canCancelPause}
                onPress={() => void run("cancel")}
              />
            ) : null}
            {availability.ready ||
            (session.phase === "resuming" && !availability.showPauseAgain) ? (
              <ControlPill
                label={
                  pending ? "Sending…" : session.phase === "resuming" ? "Retry resume" : "Resume"
                }
                variant="primary"
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
