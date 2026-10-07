import * as Option from "effect/Option";
import type { ConnectionCatalogEntry } from "./connection/catalog.ts";
import type { PreparedConnection } from "./connection/model.ts";
import {
  PREVIEW_URL_MAX_LENGTH,
  type PreviewHostingLeaseSummary,
  type PreviewHostingRecoverResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "@t3tools/shared/remote";
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

export class HostedPreviewUrlTooLongError extends Error {
  constructor() {
    super(
      `The preview URL exceeds ${PREVIEW_URL_MAX_LENGTH} characters after resolving the environment address. Use a shorter preview path or query.`,
    );
    this.name = "HostedPreviewUrlTooLongError";
  }
}

export class HostedPreviewRecoveryError extends Error {
  constructor(cause?: unknown) {
    super(
      "The saved preview could not be started. Retry opening it when its environment is available.",
      { cause },
    );
    this.name = "HostedPreviewRecoveryError";
  }
}

export interface PrepareHostedPreviewInput {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly environmentUrl: string;
  /** Previous endpoints explicitly known to belong to this same environment. */
  readonly knownEnvironmentUrls?: ReadonlyArray<string>;
  /** Resource loads must not consume a browser-navigation credential. */
  readonly purpose?: "navigation" | "resource";
  readonly list: () => Promise<ReadonlyArray<PreviewHostingLeaseSummary>>;
  readonly recover: (
    lease: PreviewHostingLeaseSummary,
    options: { readonly bootstrap: boolean },
  ) => Promise<PreviewHostingRecoverResult>;
}

export interface PreparedHostedPreview {
  readonly url: string;
  readonly managed: boolean;
  readonly restored: boolean;
  /** One-use navigation only; never save in handoffs, history, or copied links. */
  readonly navigationUrl?: string;
  readonly restarted?: boolean;
}

/** Use only at the navigation boundary; retained destinations stay credential-free. */
export function hostedPreviewNavigationUrl(
  prepared: Pick<PreparedHostedPreview, "url" | "navigationUrl">,
  destination = prepared.url,
): string {
  const token = prepared.navigationUrl
    ? getPairingTokenFromUrl(new URL(prepared.navigationUrl))
    : null;
  return token ? setPairingTokenOnUrl(new URL(destination), token).href : destination;
}

const inFlightListings = new Map<string, Promise<ReadonlyArray<PreviewHostingLeaseSummary>>>();
const inFlightRecoveries = new Map<string, Promise<PreviewHostingRecoverResult>>();

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
  return (async (): Promise<PreparedHostedPreview> => {
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
    const destination = resolveOwnedPreviewUrl(target, environment, targetIsPreviousPrivateAddress);
    if (destination.length > PREVIEW_URL_MAX_LENGTH) throw new HostedPreviewUrlTooLongError();
    let recovered: PreviewHostingRecoverResult;
    try {
      // Each navigation needs its own one-use credential, including two opens
      // of the same URL. Only resource recovery can share the complete result.
      recovered =
        input.purpose === "resource"
          ? await sharePending(
              inFlightRecoveries,
              JSON.stringify([scope, owned.leaseId, owned.url]),
              () => input.recover(owned, { bootstrap: false }),
            )
          : await input.recover(owned, { bootstrap: true });
    } catch (cause) {
      throw new HostedPreviewRecoveryError(cause);
    }
    if (recovered === null) throw new HostedPreviewRecoveryError();
    const navigationUrl =
      input.purpose !== "resource" && recovered.bootstrapToken
        ? setPairingTokenOnUrl(new URL(destination), recovered.bootstrapToken).href
        : undefined;
    if (navigationUrl !== undefined && navigationUrl.length > PREVIEW_URL_MAX_LENGTH)
      throw new HostedPreviewUrlTooLongError();
    return {
      url: destination,
      managed: true,
      restored: true,
      ...(navigationUrl === undefined ? {} : { navigationUrl }),
      ...(recovered.restarted ? { restarted: true } : {}),
    };
  })();
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
