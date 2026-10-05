import { useNavigation } from "@react-navigation/native";
import { presentThreadRecovery } from "@t3tools/client-runtime/state/thread-recovery";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadRecoveryNotice({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  const recover = useAtomCommand(threadEnvironment.recoverThread, { reportFailure: false });
  const repair = useAtomCommand(threadEnvironment.repairThread, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const recovery = thread.recovery;
  const key = `${environmentId}:${thread.id}:${recovery?.runId}:${recovery?.attemptId}`;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentKey = useRef(key);
  currentKey.current = key;
  const presentation = presentThreadRecovery(recovery);
  if (!recovery || !presentation || (dismissed && recovery.status === "recovered")) return null;
  const act = async () => {
    if (pending || presentation.busy) return;
    if (recovery.repairThreadId) {
      navigation.navigate("Thread", { environmentId, threadId: recovery.repairThreadId });
      return;
    }
    setPending(true);
    setError(null);
    const input = { threadId: thread.id, runId: recovery.runId, attemptId: recovery.attemptId };
    try {
      if (presentation.action === "launch-repair") {
        const result = await repair({ environmentId, input });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (mounted.current && currentKey.current === key)
          navigation.navigate("Thread", { environmentId, threadId: result.value.threadId });
      } else {
        const result = await recover({ environmentId, input });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not recover this run.");
    } finally {
      setPending(false);
    }
  };
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-background p-3">
      <Text
        accessibilityLiveRegion="polite"
        accessibilityRole="header"
        className="text-sm font-t3-bold text-foreground"
      >
        {presentation.title}
      </Text>
      <Text className="text-xs text-muted-foreground">{presentation.description}</Text>
      <View className="flex-row justify-end">
        {presentation.label ? (
          <ControlPill
            label={
              pending
                ? presentation.action === "launch-repair"
                  ? "Opening…"
                  : recovery.status === "suspect"
                    ? "Checking…"
                    : "Recovering…"
                : presentation.label
            }
            disabled={pending || presentation.busy}
            onPress={() => void act()}
            variant="pill"
          />
        ) : (
          <ControlPill label="Dismiss" onPress={() => setDismissed(true)} variant="pill" />
        )}
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
