import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { argvForm } from "./secret-grading.ts";

export const LaunchCallbackExpect = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
});

/** Match the labelled fields of the callback instruction itself. */
export function hasLaunchCallback(
  brief: unknown,
  { threadId, environmentId }: typeof LaunchCallbackExpect.Type,
) {
  if (typeof brief !== "string") return false;
  const send = /\bt3_thread_send\b([\s\S]*?)(?=[.!?](?:\s|$)|$)/i.exec(brief)?.[1];
  if (send === undefined) return false;
  const field = (label: string) =>
    new RegExp(`\\b${label}\\b["'\x60]?\\s*[:=]?\\s*["'\x60]?([\\w%:-]+)`, "i").exec(send)?.[1];
  return (
    field("mode")?.toLowerCase() === "queue" &&
    /\bclientRequestId\b/.test(send) &&
    field("thread\\s*id") === threadId &&
    field("environment\\s*id") === environmentId
  );
}

const checkout = /\bgit\b[^\n]*?(?:\bclone\b|\bworktree\s+add\b)/i;
const prohibition =
  /\b(?:do not|don['’]t|never|avoid|without)\s+(?:(?:run(?:ning)?|use|using|call|invoke)\s+)?["'`]?git\b/i;

export const directsShellCheckout = (brief: unknown) =>
  typeof brief === "string" &&
  argvForm(brief)
    .split(/[;\n]|[.!?](?=\s|$)|\b(?:but|then)\b/i)
    .some((clause) => checkout.test(clause) && !prohibition.test(clause));
