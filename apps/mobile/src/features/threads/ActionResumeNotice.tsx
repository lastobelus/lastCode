import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { terminalEnvironment } from "../../state/terminal";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function failureMessage(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export function ActionResumeNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationThreadShell;
}) {
  const action = props.thread.actionResume ?? null;
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const resumeAction = useAtomCommand(threadEnvironment.resumeAction, { reportFailure: false });
  const discardAction = useAtomCommand(threadEnvironment.discardAction, { reportFailure: false });
  const [pendingAction, setPendingAction] = useState<"cancel" | "resume" | "discard" | null>(null);

  useEffect(() => setPendingAction(null), [action?.runId, action?.delivery, action?.outcome]);

  const cancel = useCallback(async () => {
    if (action?.outcome !== "running" || pendingAction !== null) return;
    setPendingAction("cancel");
    const result = await closeTerminal({
      environmentId: props.environmentId,
      input: { threadId: props.thread.id, terminalId: action.terminalId },
    });
    if (result._tag === "Failure") {
      setPendingAction(null);
      Alert.alert(
        "Could not cancel Action",
        failureMessage(result.cause, "The Project Action could not be cancelled."),
      );
    }
  }, [action, closeTerminal, pendingAction, props.environmentId, props.thread.id]);

  const recover = useCallback(
    async (choice: "resume" | "discard") => {
      if (action?.delivery !== "available" || pendingAction !== null) return;
      setPendingAction(choice);
      const command = choice === "resume" ? resumeAction : discardAction;
      const result = await command({
        environmentId: props.environmentId,
        input: { threadId: props.thread.id },
      });
      if (result._tag === "Failure") {
        setPendingAction(null);
        Alert.alert(
          choice === "resume" ? "Could not resume agent" : "Could not discard follow-up",
          failureMessage(result.cause, "The interrupted Action follow-up could not be updated."),
        );
      }
    },
    [
      action?.delivery,
      discardAction,
      pendingAction,
      props.environmentId,
      props.thread.id,
      resumeAction,
    ],
  );

  if (action?.outcome === "running") {
    return (
      <View className="rounded-2xl border border-yellow-400/35 bg-yellow-500/10 px-3.5 py-3 dark:border-yellow-300/20">
        <View className="flex-row items-center gap-2.5">
          <SymbolView name="clock" size={18} tintColor="#eab308" type="monochrome" />
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-t3-bold text-yellow-800 dark:text-yellow-200">
              Waiting for {action.actionName}
            </Text>
            <Text className="mt-0.5 text-xs text-yellow-800/75 dark:text-yellow-200/70">
              The agent will resume once this Action finishes and the thread is idle.
            </Text>
          </View>
          <ControlPill
            accessibilityLabel={`Cancel ${action.actionName}`}
            disabled={pendingAction !== null}
            label={pendingAction === "cancel" ? "Cancelling…" : "Cancel"}
            onPress={() => void cancel()}
            variant="pill"
          />
        </View>
      </View>
    );
  }

  if (action?.delivery !== "available") return null;

  return (
    <View className="rounded-2xl border border-yellow-400/35 bg-yellow-500/10 px-3.5 py-3 dark:border-yellow-300/20">
      <View className="flex-row items-start gap-2.5">
        <SymbolView
          name="exclamationmark.triangle"
          size={18}
          tintColor="#eab308"
          type="monochrome"
        />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-t3-bold text-yellow-800 dark:text-yellow-200">
            {action.actionName} was interrupted
          </Text>
          <Text className="mt-0.5 text-xs text-yellow-800/75 dark:text-yellow-200/70">
            LastCode did not restart the command or wake the agent. Resume only the agent follow-up
            when you are ready.
          </Text>
          <View className="mt-2.5 flex-row justify-end gap-2">
            <ControlPill
              disabled={pendingAction !== null}
              label={pendingAction === "discard" ? "Discarding…" : "Discard"}
              onPress={() => void recover("discard")}
              variant="pill"
            />
            <ControlPill
              disabled={pendingAction !== null}
              label={pendingAction === "resume" ? "Resuming…" : "Resume agent"}
              onPress={() => void recover("resume")}
              variant="primary"
            />
          </View>
        </View>
      </View>
    </View>
  );
}
