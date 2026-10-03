import * as Option from "effect/Option";
import type { ConnectionCatalogEntry } from "./connection/catalog.ts";
import type { PreparedConnection } from "./connection/model.ts";
import type { PreviewHostingLeaseSummary, ScopedThreadRef } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  normalizeHostname,
} from "@t3tools/shared/hostClassification";

/** A configured endpoint is trusted only when it belongs to the prepared environment. */
export function configuredPreviewEnvironmentUrl(
  connection: PreparedConnection,
  entry: ConnectionCatalogEntry | undefined,
): string | null {
  if (connection.target._tag === "PrimaryConnectionTarget") return connection.target.httpBaseUrl;
  if (
    connection.target._tag !== "BearerConnectionTarget" ||
    entry?.target._tag !== "BearerConnectionTarget" ||
    entry.target.environmentId !== connection.environmentId ||
    entry.target.connectionId !== connection.target.connectionId ||
    Option.isNone(entry.profile)
  )
    return null;
  const profile = entry.profile.value;
  return profile._tag === "BearerConnectionProfile" &&
    profile.environmentId === connection.environmentId &&
    profile.connectionId === connection.target.connectionId
    ? profile.httpBaseUrl
    : null;
}

export interface PrepareHostedPreviewInput {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly environmentUrl: string;
  /** Previous endpoints explicitly known to belong to this same environment. */
  readonly knownEnvironmentUrls?: ReadonlyArray<string>;
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
const inFlightListings = new Map<string, Promise<ReadonlyArray<PreviewHostingLeaseSummary>>>();
const inFlightRecoveries = new Map<string, Promise<PreviewHostingLeaseSummary | null>>();

/** Share pending work only; a later opening must check the server again. */
function sharePending<A>(pending: Map<string, Promise<A>>, key: string, run: () => Promise<A>) {
  const existing = pending.get(key);
  if (existing) return existing;
  const result = Promise.resolve()
    .then(run)
    .finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

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
  const targetIsPreviousPrivateAddress = isKnownPreviousPrivateAddress(
    target,
    environment,
    input.knownEnvironmentUrls ?? [],
  );
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    (environment.protocol !== "http:" && environment.protocol !== "https:") ||
    (!targetIsLoopback && !targetIsCurrentEnvironment && !targetIsPreviousPrivateAddress)
  ) {
    return Promise.resolve(original);
  }

  const scope = JSON.stringify([
    input.threadRef.environmentId,
    input.threadRef.threadId,
    input.environmentUrl,
    input.knownEnvironmentUrls ?? [],
  ]);
  const key = JSON.stringify([scope, input.url]);
  const existing = inFlightPreparations.get(key);
  if (existing) return existing;

  const preparation = (async (): Promise<PreparedHostedPreview> => {
    let leases: ReadonlyArray<PreviewHostingLeaseSummary>;
    try {
      leases = await sharePending(inFlightListings, scope, input.list);
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
      restored =
        (await sharePending(
          inFlightRecoveries,
          JSON.stringify([scope, owned.leaseId, owned.url]),
          () => input.recover(owned),
        )) !== null;
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

function isKnownPreviousPrivateAddress(
  target: URL,
  environment: URL,
  knownEnvironmentUrls: ReadonlyArray<string>,
): boolean {
  return (
    !isLoopbackHost(target.hostname) &&
    normalizeHostname(target.hostname) !== normalizeHostname(environment.hostname) &&
    isPrivateNetworkHost(target.hostname) &&
    isPrivateNetworkHost(environment.hostname) &&
    knownEnvironmentUrls.some((knownUrl) => {
      try {
        const known = new URL(knownUrl);
        return (
          (known.protocol === "http:" || known.protocol === "https:") &&
          isPrivateNetworkHost(known.hostname) &&
          normalizeHostname(known.hostname) === normalizeHostname(target.hostname)
        );
      } catch {
        return false;
      }
    })
  );
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
