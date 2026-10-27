import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  actionRunningPresentation,
  actionResultPresentation,
  actionResumeControlCopy,
  actionResumeUnknownPresentation,
  environmentPausePresentation,
} from "@t3tools/shared/actionResume";
import * as Cause from "effect/Cause";
import { useCallback, useState } from "react";
import { View } from "react-native";
import * as Dialog from "../../components/ui/Dialog";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { terminalEnvironment } from "../../state/terminal";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useActionEnvironmentPause, useActionResumeWait } from "./action-resume-state";
import { useEnvironmentPauseControl } from "./EnvironmentPauseControl";

function failureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function ActionResumeNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
}) {
  const action = props.thread.actionResume ?? null;
  const pause = useActionEnvironmentPause(props.environmentId);
  const pauseControl = useEnvironmentPauseControl(props.environmentId);
  const { presentation } = useActionResumeWait(
    scopeThreadRef(props.environmentId, props.thread.id),
    action,
    pause.paused,
  );
  const canCancel = useAtomValue(terminalEnvironment.close.permissionAtom(props.environmentId));
  const canResume = useAtomValue(
    threadEnvironment.resumeAction.permissionAtom(props.environmentId),
  );
  const canDiscard = useAtomValue(
    threadEnvironment.discardAction.permissionAtom(props.environmentId),
  );
  const pausePresentation =
    pause.phase !== null
      ? environmentPausePresentation(pause.phase)
      : pause.showUnknown && presentation === null
        ? actionResumeUnknownPresentation
        : null;
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const resumeAction = useAtomCommand(threadEnvironment.resumeAction, { reportFailure: false });
  const discardAction = useAtomCommand(threadEnvironment.discardAction, { reportFailure: false });
  const actionKey = `${action?.runId}:${action?.delivery}:${action?.outcome}`;
  const [pending, setPending] = useState<{
    readonly key: string;
    readonly choice: "cancel" | "resume" | "discard";
  } | null>(null);
  const pendingAction = pending?.key === actionKey ? pending.choice : null;

  const cancel = useCallback(async () => {
    if (action?.outcome !== "running" || pendingAction !== null || !canCancel) return;
    setPending({ key: actionKey, choice: "cancel" });
    const result = await closeTerminal({
      environmentId: props.environmentId,
      input: { threadId: props.thread.id, terminalId: action.terminalId },
    });
    if (result._tag === "Failure") {
      setPending(null);
      Dialog.alert(
        "Could not cancel Action",
        failureMessage(result.cause, "The Project Action could not be cancelled."),
      );
    }
  }, [
    action,
    actionKey,
    canCancel,
    closeTerminal,
    pendingAction,
    props.environmentId,
    props.thread.id,
  ]);

  const recover = useCallback(
    async (choice: "resume" | "discard") => {
      if (action?.delivery !== "available" || pendingAction !== null) return;
      if (choice === "resume" ? !canResume : !canDiscard) return;
      setPending({ key: actionKey, choice });
      const command = choice === "resume" ? resumeAction : discardAction;
      const result = await command({
        environmentId: props.environmentId,
        input: { threadId: props.thread.id },
      });
      if (result._tag === "Failure") {
        setPending(null);
        Dialog.alert(
          choice === "resume" ? "Could not resume agent" : "Could not discard follow-up",
          failureMessage(result.cause, "The interrupted Action follow-up could not be updated."),
        );
      }
    },
    [
      action?.delivery,
      actionKey,
      canDiscard,
      canResume,
      discardAction,
      pendingAction,
      props.environmentId,
      props.thread.id,
      resumeAction,
    ],
  );

  const running = action?.outcome === "running" ? actionRunningPresentation(action) : null;
  const result =
    action && action.outcome !== "running"
      ? actionResultPresentation({
          lifecycleOutcome: action.outcome,
          validatedStatus: action.outcome,
          exitCode: action.exitCode,
          report: action.report ?? null,
          lastOutputLine: "",
        })
      : null;
  if (presentation === null && pausePresentation === null && pauseControl.modal === null)
    return null;
  return (
    <View className="gap-3 px-4 pb-3">
      {presentation && action ? (
        <View
          className={
            presentation.tone === "warning"
              ? "rounded-2xl border border-adaptive-yellow-400-a35-300-a20 bg-yellow-500/10 px-3.5 py-3"
              : "rounded-2xl border border-sky-500/25 bg-sky-500/10 px-3.5 py-3"
          }
        >
          <View className="flex-row items-start gap-2.5">
            <SymbolView
              name={presentation.tone === "warning" ? "exclamationmark.triangle" : "gearshape"}
              size={18}
              tintColor={presentation.tone === "warning" ? "#eab308" : "#0a84ff"}
              type="monochrome"
            />
            <View className="min-w-0 flex-1 gap-1">
              <Text className="text-sm font-t3-bold text-foreground">{action.actionName}</Text>
              <Text className="text-xs font-t3-medium text-foreground-secondary">
                {presentation.label}
              </Text>
              {running ? (
                <Text className="text-xs text-foreground-secondary">
                  {running.label}: {running.summary}
                </Text>
              ) : null}
              {result ? (
                <Text className="text-xs text-foreground-secondary">
                  {result.label}
                  {result.summary ? `: ${result.summary}` : ""}
                </Text>
              ) : null}
              <Text className="text-xs text-foreground-secondary">{presentation.detail}</Text>
              {running || action.delivery === "available" ? (
                <View className="mt-2 flex-row flex-wrap justify-end gap-2">
                  {running ? (
                    <Button
                      accessibilityHint={actionResumeControlCopy.cancel.detail}
                      disabled={pendingAction !== null || !canCancel}
                      label={
                        pendingAction === "cancel"
                          ? "Cancelling…"
                          : actionResumeControlCopy.cancel.label
                      }
                      onPress={() => void cancel()}
                      tone="secondary"
                    />
                  ) : (
                    <>
                      <Button
                        accessibilityHint={actionResumeControlCopy.discard.detail}
                        disabled={pendingAction !== null || !canDiscard}
                        label={
                          pendingAction === "discard"
                            ? "Discarding…"
                            : actionResumeControlCopy.discard.label
                        }
                        onPress={() => void recover("discard")}
                        tone="secondary"
                      />
                      <Button
                        accessibilityHint={actionResumeControlCopy.resume_agent.detail}
                        disabled={pendingAction !== null || !canResume}
                        label={
                          pendingAction === "resume"
                            ? "Resuming…"
                            : actionResumeControlCopy.resume_agent.label
                        }
                        onPress={() => void recover("resume")}
                        tone="primary"
                      />
                    </>
                  )}
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
      {pausePresentation ? (
        <View className="gap-1 rounded-2xl border border-adaptive-yellow-400-a35-300-a20 bg-yellow-500/10 px-3.5 py-3">
          <Text className="text-sm font-t3-bold text-foreground">{pausePresentation.label}</Text>
          <Text className="text-xs text-foreground-secondary">{pausePresentation.detail}</Text>
          {pauseControl.visible ? (
            <View className="mt-2 items-end">
              <Button
                label={actionResumeControlCopy.manage_pause.label}
                accessibilityHint={actionResumeControlCopy.manage_pause.detail}
                onPress={pauseControl.onPress}
                tone="secondary"
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {pauseControl.modal}
    </View>
  );
}
