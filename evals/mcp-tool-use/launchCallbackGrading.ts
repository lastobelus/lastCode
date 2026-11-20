import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const LaunchCallbackExpect = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
});

/** Match labelled destination fields in prose or a tool-call example. */
export function hasLaunchCallback(
  brief: unknown,
  { threadId, environmentId }: typeof LaunchCallbackExpect.Type,
) {
  if (typeof brief !== "string") return false;
  const send = /\bt3_thread_send\b([\s\S]*)/i.exec(brief)?.[1];
  if (send === undefined) return false;
  const mode = /\bmode\b["'`]?\s*[:=]?\s*["'`]?(queue|auto|steer|restart)\b/i.exec(send)?.[1];
  const hasValue = (label: string, id: string) =>
    new RegExp(
      `\\b${label}\\b["'\x60]?\\s*[:=]?\\s*["'\x60]?${RegExp.escape(id)}(?![\\w-])`,
      "i",
    ).test(brief);
  const thread = "(?:threadId|thread(?:\\s+id)?)";
  const environment = "(?:environmentId|environment(?:\\s+id)?)";
  return (
    mode?.toLowerCase() === "queue" &&
    /\bclientRequestId\b/.test(send) &&
    hasValue(thread, threadId) &&
    hasValue(environment, environmentId) &&
    !hasValue(thread, environmentId) &&
    !hasValue(environment, threadId)
  );
}
