import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isProviderNativeSubagentThread } from "@t3tools/contracts";

export function quickMessageBlockReason(
  thread: EnvironmentThreadShell | null,
  connected: boolean,
  unacknowledged = false,
): string | null {
  // A retained command confirms its original receipt, even if the thread changed later.
  if (unacknowledged) return connected ? null : "Reconnect to this environment before sending.";
  if (!thread || thread.deletedAt) return "This thread is no longer available.";
  if (thread.archivedAt) return "Open and restore this archived thread to send a message.";
  if (isProviderNativeSubagentThread(thread.source)) {
    return "This conversation is managed by its parent agent. Open the thread to continue.";
  }
  if (!connected) return "Reconnect to this environment before sending.";
  if (thread.hasPendingApprovals) return "Open the thread to respond to its approval request.";
  if (thread.hasPendingUserInput) return "Open the thread to answer its question.";
  return null;
}

/** Retain a command until acknowledged so a lost response cannot duplicate a retry. */
export function createQuickMessageSender<Input, Result extends { readonly _tag: string }>(
  send: (input: Input) => Promise<Result>,
) {
  const attempts = new Map<string, Input>();
  const pending = new Set<string>();
  return {
    hasUnacknowledgedMessage: (key: string) => attempts.has(key),
    discardAttempt(key: string): boolean {
      if (pending.has(key)) return false;
      return attempts.delete(key);
    },
    async submit(key: string, createInput: () => Input): Promise<Result | undefined> {
      if (pending.has(key)) return undefined;
      const input = attempts.get(key) ?? createInput();
      attempts.set(key, input);
      pending.add(key);
      try {
        const result = await send(input);
        if (result._tag === "Success") attempts.delete(key);
        return result;
      } finally {
        pending.delete(key);
      }
    },
  };
}
