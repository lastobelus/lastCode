import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useQuietThreadShell } from "../../state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLastCodeThreadStatus } from "../../components/sidebar/useLastCodeThreadStatus";
import { LastCodeThreadStatusLabel } from "../../components/sidebar/LastCodeThreadStatusLabel";

export function TagThreadRow({
  thread: fallback,
  context,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly context: string;
}) {
  const thread =
    useQuietThreadShell(scopeThreadRef(fallback.environmentId, fallback.id)) ?? fallback;
  const status = useLastCodeThreadStatus(thread);
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {status ? (
          <LastCodeThreadStatusLabel status={status} />
        ) : (
          <span className="text-xs text-muted-foreground">
            {thread.settledOverride === "settled" ? "Settled" : "Ready"}
          </span>
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground">{context}</span>
    </span>
  );
}
