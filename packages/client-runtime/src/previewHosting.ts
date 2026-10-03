import type { PreviewHostingLeaseSummary, ScopedThreadRef } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  normalizeHostname,
} from "@t3tools/shared/hostClassification";

export interface PrepareHostedPreviewInput {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly environmentUrl: string;
  readonly list: () => Promise<ReadonlyArray<PreviewHostingLeaseSummary>>;
  readonly recover: (
    lease: PreviewHostingLeaseSummary,
  ) => Promise<PreviewHostingLeaseSummary | null>;
}

export interface PreparedHostedPreview {
  readonly url: string;
  readonly managed: boolean;
  readonly restored: boolean;
}

const inFlightPreparations = new Map<string, Promise<PreparedHostedPreview>>();

/** Pick the sole lease on this port, preferring an exact path and query match. */
export function selectHostedPreview(
  url: URL,
  leases: ReadonlyArray<PreviewHostingLeaseSummary>,
): PreviewHostingLeaseSummary | null {
  const candidates = leases.filter((lease) => {
    try {
      const canonical = new URL(lease.url);
      return canonical.protocol === url.protocol && canonical.port === url.port;
    } catch {
      return false;
    }
  });
  const exact = candidates.filter((lease) => {
    const canonical = new URL(lease.url);
    return canonical.pathname === url.pathname && canonical.search === url.search;
  });
  return exact.length === 1 ? exact[0]! : candidates.length === 1 ? candidates[0]! : null;
}

/** Restore only a matching lease owned by this thread, without creating an agent turn. */
export function prepareHostedPreview(
  input: PrepareHostedPreviewInput,
): Promise<PreparedHostedPreview> {
  const original = { url: input.url, managed: false, restored: false } as const;
  let target: URL;
  let environment: URL;
  try {
    target = new URL(input.url);
    environment = new URL(input.environmentUrl);
  } catch {
    return Promise.resolve(original);
  }
  const targetIsLoopback = isLoopbackHost(target.hostname);
  const targetIsCurrentEnvironment =
    normalizeHostname(target.hostname) === normalizeHostname(environment.hostname);
  const targetIsPreviousPrivateAddress =
    !targetIsLoopback &&
    !targetIsCurrentEnvironment &&
    isPrivateNetworkHost(target.hostname) &&
    isPrivateNetworkHost(environment.hostname);
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    (environment.protocol !== "http:" && environment.protocol !== "https:") ||
    (!targetIsLoopback && !targetIsCurrentEnvironment && !targetIsPreviousPrivateAddress)
  ) {
    return Promise.resolve(original);
  }

  const key = JSON.stringify([
    input.threadRef.environmentId,
    input.threadRef.threadId,
    input.url,
    input.environmentUrl,
  ]);
  const existing = inFlightPreparations.get(key);
  if (existing) return existing;

  const preparation = (async (): Promise<PreparedHostedPreview> => {
    let leases: ReadonlyArray<PreviewHostingLeaseSummary>;
    try {
      leases = await input.list();
    } catch {
      return original;
    }
    const threadLeases = leases.filter((lease) => lease.threadId === input.threadRef.threadId);
    const owned = targetIsPreviousPrivateAddress
      ? selectExactPrivateHostedPreview(target, threadLeases)
      : selectHostedPreview(target, threadLeases);
    if (!owned) return original;
    let restored = false;
    try {
      restored = (await input.recover(owned)) !== null;
    } catch {
      // Keep the managed destination when the best-effort restore request fails.
    }
    return {
      url: resolveOwnedPreviewUrl(target, environment, targetIsPreviousPrivateAddress),
      managed: true,
      restored,
    };
  })().finally(() => {
    inFlightPreparations.delete(key);
  });
  inFlightPreparations.set(key, preparation);
  return preparation;
}

function selectExactPrivateHostedPreview(
  url: URL,
  leases: ReadonlyArray<PreviewHostingLeaseSummary>,
): PreviewHostingLeaseSummary | null {
  const exact = leases.filter((lease) => {
    try {
      const canonical = new URL(lease.url);
      return (
        (canonical.protocol === "http:" || canonical.protocol === "https:") &&
        (isLoopbackHost(canonical.hostname) || isPrivateNetworkHost(canonical.hostname)) &&
        canonical.protocol === url.protocol &&
        canonical.port === url.port &&
        canonical.pathname === url.pathname &&
        canonical.search === url.search
      );
    } catch {
      return false;
    }
  });
  return exact.length === 1 ? exact[0]! : null;
}

function resolveOwnedPreviewUrl(
  target: URL,
  environment: URL,
  targetIsPreviousPrivateAddress: boolean,
): string {
  if (
    (!isLoopbackHost(target.hostname) && !targetIsPreviousPrivateAddress) ||
    !isPrivateNetworkHost(environment.hostname)
  ) {
    return target.toString();
  }
  const resolvedHost = isLocalLoopbackHost(environment.hostname)
    ? "localhost"
    : environment.hostname;
  target.hostname = resolvedHost;
  return target.toString();
}
