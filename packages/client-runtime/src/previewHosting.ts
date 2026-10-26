import * as Option from "effect/Option";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ConnectionCatalogEntry } from "./connection/catalog.ts";
import type { PreparedConnection } from "./connection/model.ts";
import {
  PREVIEW_URL_MAX_LENGTH,
  PreviewHostingError,
  type PreviewHostingLeaseSummary,
  type PreviewHostingRecoverResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { getPairingTokenFromUrl, setPreviewBootstrapTokenOnUrl } from "@t3tools/shared/remote";
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

const isPreviewHostingError = Schema.is(PreviewHostingError);

export class HostedPreviewRecoveryError extends Error {
  constructor(cause?: unknown) {
    super(
      isPreviewHostingError(cause) && cause.reason === "capacity"
        ? "Managed previews are at capacity. Your preview is saved. Close an active Browser view or finish its automation or recording, then retry."
        : "The saved preview could not be started. Retry opening it when its environment is available.",
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
  /** Asset callbacks return null only when bootstrap confirms recovery is unsupported. */
  readonly createResourceUrl?:
    | ((lease: PreviewHostingLeaseSummary, localUrl: string) => Promise<string | null>)
    | undefined;
  readonly renewDocumentUrl?:
    | ((url: string, refresh: boolean) => Promise<string | null>)
    | undefined;
}

export interface PreparedHostedPreview {
  readonly url: string;
  /** Verified lease destination as reached by a browser in the owning environment. */
  readonly localUrl?: string;
  /** Signed exact resource URL on the connected environment origin for native media viewers. */
  readonly resourceUrl?: string;
  readonly managed: boolean;
  readonly restored: boolean;
  /** One-use navigation only; never save in handoffs, history, or copied links. */
  readonly navigationUrl?: string;
  readonly restarted?: boolean;
  readonly runId?: string;
}

/** Use only at the navigation boundary; retained destinations stay credential-free. */
export function hostedPreviewNavigationUrl(
  prepared: Pick<PreparedHostedPreview, "url" | "navigationUrl">,
  destination = prepared.url,
): string {
  const token = prepared.navigationUrl
    ? getPairingTokenFromUrl(new URL(prepared.navigationUrl))
    : null;
  return token ? setPreviewBootstrapTokenOnUrl(new URL(destination), token).href : destination;
}

const inFlightListings = new Map<string, Promise<ReadonlyArray<PreviewHostingLeaseSummary>>>();
const inFlightRecoveries = new Map<string, Promise<PreviewHostingRecoverResult>>();

const decodeSavedDocumentClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      kind: Schema.Literals([
        "attachment",
        "workspace-file",
        "workspace-file-exact",
        "media-file-exact",
        "managed-preview-resource",
      ]),
      expiresAt: Schema.Number,
    }),
  ),
);

function isSavedDocumentCapability(url: URL): boolean {
  const match = /^\/api\/assets\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\/.+$/u.exec(url.pathname);
  if (!match) return false;
  const decoded = Base64Url.decodeString(match[1]!);
  // Recognition only: the environment validates the full claims and signature on renewal.
  return Result.isSuccess(decoded) && Option.isSome(decodeSavedDocumentClaims(decoded.success));
}

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
  const targetIsEnvironmentOrigin =
    target.origin === environment.origin ||
    input.knownEnvironmentUrls?.some((known) => {
      try {
        return new URL(known).origin === target.origin;
      } catch {
        return false;
      }
    }) === true;
  const targetIsDocumentCandidate =
    (target.protocol === "http:" || target.protocol === "https:") &&
    target.pathname.startsWith("/api/assets/") &&
    (targetIsEnvironmentOrigin ||
      (isLoopbackHost(target.hostname) && isSavedDocumentCapability(target)));
  const renewDocument = async (): Promise<PreparedHostedPreview> => {
    if (!targetIsDocumentCandidate || input.renewDocumentUrl === undefined) return original;
    try {
      const issued = await input.renewDocumentUrl(input.url, input.purpose !== "resource");
      if (issued === null) return original;
      const renewed = connectedAssetUrl(issued, environment);
      return {
        url: renewed,
        managed: false,
        restored: true,
        ...(renewed === input.url ? {} : { restarted: true }),
      };
    } catch (cause) {
      throw new HostedPreviewRecoveryError(cause);
    }
  };
  // Other loopback ports can serve app-owned asset capabilities; check their leases first.
  if (targetIsDocumentCandidate && targetIsEnvironmentOrigin) return renewDocument();
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
      return renewDocument();
    }
    const threadLeases = leases.filter((lease) => lease.threadId === input.threadRef.threadId);
    const selectOwned = targetIsPreviousPrivateAddress
      ? selectExactPrivateHostedPreview
      : selectHostedPreview;
    let owned = selectOwned(target, threadLeases);
    if (
      !owned &&
      target.protocol === "https:" &&
      !targetIsLoopback &&
      !targetIsPreviousPrivateAddress
    ) {
      // A published HTTPS endpoint can proxy the same port's owned HTTP listener.
      // Restrict this to the current host so resolution preserves its TLS hostname.
      const localHttp = new URL(target);
      localHttp.protocol = "http:";
      localHttp.port = target.port || "443";
      owned = selectOwned(localHttp, threadLeases);
    }
    if (!owned) return renewDocument();
    const localDestination = new URL(target);
    const canonical = new URL(owned.url);
    localDestination.protocol = canonical.protocol;
    localDestination.hostname = canonical.hostname;
    localDestination.port = canonical.port;
    const localUrl = localDestination.href;
    const destination = resolveOwnedPreviewUrl(target, environment, targetIsPreviousPrivateAddress);
    if (destination.length > PREVIEW_URL_MAX_LENGTH || localUrl.length > PREVIEW_URL_MAX_LENGTH)
      throw new HostedPreviewUrlTooLongError();
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
    let resourceUrl: string | undefined;
    if (input.purpose === "resource" && input.createResourceUrl !== undefined) {
      try {
        const issued = await input.createResourceUrl(owned, localUrl);
        if (issued !== null) resourceUrl = connectedAssetUrl(issued, environment);
      } catch (cause) {
        throw new HostedPreviewRecoveryError(cause);
      }
    }
    const navigationUrl =
      input.purpose !== "resource" && recovered.bootstrapToken
        ? setPreviewBootstrapTokenOnUrl(new URL(destination), recovered.bootstrapToken).href
        : undefined;
    if (navigationUrl !== undefined && navigationUrl.length > PREVIEW_URL_MAX_LENGTH)
      throw new HostedPreviewUrlTooLongError();
    return {
      url: destination,
      localUrl,
      ...(resourceUrl === undefined ? {} : { resourceUrl }),
      managed: true,
      restored: true,
      ...(navigationUrl === undefined ? {} : { navigationUrl }),
      ...(recovered.restarted ? { restarted: true } : {}),
      ...(recovered.runId === undefined ? {} : { runId: recovered.runId }),
    };
  })();
}

function connectedAssetUrl(issued: string, environment: URL): string {
  const asset = new URL(issued, environment);
  if (
    (environment.protocol !== "http:" && environment.protocol !== "https:") ||
    asset.origin !== environment.origin ||
    asset.username !== "" ||
    asset.password !== "" ||
    !asset.pathname.startsWith("/api/assets/")
  )
    throw new HostedPreviewRecoveryError();
  return asset.href;
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
