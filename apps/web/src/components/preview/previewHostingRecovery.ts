import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { PreviewHostingLeaseSummary, ScopedThreadRef } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";
import { previewEnvironment } from "~/state/preview";

function environmentPreviewUrl(url: string, environmentUrl: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHost(parsed.hostname) && parsed.hostname !== new URL(environmentUrl).hostname) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Match the owned server across localhost aliases and private-network origin resolution. */
export function selectHostedPreview(
  url: URL,
  leases: ReadonlyArray<PreviewHostingLeaseSummary>,
): PreviewHostingLeaseSummary | null {
  const candidates = leases.filter((lease) => {
    const canonical = new URL(lease.url);
    return canonical.protocol === url.protocol && canonical.port === url.port;
  });
  const exact = candidates.filter((lease) => {
    const canonical = new URL(lease.url);
    return canonical.pathname === url.pathname && canonical.search === url.search;
  });
  return exact.length === 1 ? exact[0]! : candidates.length === 1 ? candidates[0]! : null;
}

const pendingRecoveries = new Map<string, Promise<boolean>>();

/** Restore only this thread's native preview; never send an agent message. */
export function recoverHostedPreview(threadRef: ScopedThreadRef, url: string): Promise<boolean> {
  const connection = readPreparedConnection(threadRef.environmentId);
  if (!connection) return Promise.resolve(false);
  const parsed = environmentPreviewUrl(url, connection.httpBaseUrl);
  if (!parsed) return Promise.resolve(false);
  const key = JSON.stringify([scopedThreadKey(threadRef), url]);
  const pending = pendingRecoveries.get(key);
  if (pending) return pending;
  const task = restore(threadRef, parsed)
    .catch(() => false)
    .finally(() => pendingRecoveries.delete(key));
  pendingRecoveries.set(key, task);
  return task;
}

async function restore(threadRef: ScopedThreadRef, url: URL): Promise<boolean> {
  const leases = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.hostingList,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    },
    { reportFailure: false },
  );
  if (leases._tag === "Failure") return false;
  const owned = selectHostedPreview(
    url,
    leases.value.filter((lease) => lease.threadId === threadRef.threadId),
  );
  if (!owned) return false;
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.hostingRecover,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, leaseId: owned.leaseId, url: owned.url },
    },
    { reportFailure: false },
  );
  return result._tag === "Success" && result.value !== null;
}
