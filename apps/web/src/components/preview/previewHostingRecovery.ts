import { prepareHostedPreview as prepareOwnedPreview } from "@t3tools/client-runtime/preview-hosting";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";
import { previewEnvironment } from "~/state/preview";

export { selectHostedPreview } from "@t3tools/client-runtime/preview-hosting";

/** Intercept potential owned links before the shell opens them without recovery. */
export function mayBeHostedPreviewUrl(threadRef: ScopedThreadRef, url: string): boolean {
  const connection = readPreparedConnection(threadRef.environmentId);
  if (!connection) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (isLoopbackHost(parsed.hostname) ||
        parsed.hostname === new URL(connection.httpBaseUrl).hostname)
    );
  } catch {
    return false;
  }
}

export async function prepareHostedPreview(threadRef: ScopedThreadRef, url: string) {
  const connection = readPreparedConnection(threadRef.environmentId);
  if (!connection) return { url, managed: false, restored: false };
  return prepareOwnedPreview({
    threadRef,
    url,
    environmentUrl: connection.httpBaseUrl,
    list: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.hostingList,
        {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw new Error("Preview leases unavailable.");
      return result.value;
    },
    recover: async (lease) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        previewEnvironment.hostingRecover,
        {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, leaseId: lease.leaseId, url: lease.url },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw new Error("Preview recovery unavailable.");
      return result.value;
    },
  });
}

/** Restore only this thread's native preview; never send an agent message. */
export async function recoverHostedPreview(
  threadRef: ScopedThreadRef,
  url: string,
): Promise<boolean> {
  return (await prepareHostedPreview(threadRef, url)).restored;
}
