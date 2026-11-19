import type { RepositoryIdentity } from "@t3tools/contracts";
import { parseUrl } from "@t3tools/shared/url";

import type { SourceControlDefinitionRegistry } from "./definition.ts";

function webRemote(value: string | undefined): URL | null {
  const url = value === undefined ? null : parseUrl(value);
  return url?.protocol === "http:" || url?.protocol === "https:" ? url : null;
}

/** A canonical key omits the HTTP port, so two web remotes also need matching authorities. */
export function isSameLastCodeRepositoryOrigin(
  canonicalKey: string,
  originKey: string,
  remoteUrl: string,
  originUrl: string,
): boolean {
  if (canonicalKey !== originKey) return false;
  const canonical = webRemote(remoteUrl);
  const origin = webRemote(originUrl);
  return canonical === null || origin === null || canonical.origin === origin.origin;
}

export function issueRepositoryAddress(
  identity: RepositoryIdentity | null | undefined,
  definitions: SourceControlDefinitionRegistry,
) {
  const tracker = identity?.provider;
  if (identity == null || tracker === undefined || tracker === "unknown") return null;
  const scope = definitions.issueScope(identity);
  if (scope === null) return null;

  const fallbackHost = definitions.changeRequestHost(identity, tracker);
  const web = webRemote(identity.locator?.remoteUrl) ?? webRemote(identity.webUrl);
  // Forgejo can dispatch to an explicitly pinned HTTP server.
  if (web?.protocol === "http:" && tracker !== "forgejo") return null;
  return {
    tracker,
    scope,
    host: web?.host ?? fallbackHost,
    webOrigin: web?.origin ?? `https://${fallbackHost}`,
  };
}

/** Use the checkout's own repository for issues, including when upstream supplies its identity. */
export function selectLastCodeIssueRepository(
  identity: RepositoryIdentity | null,
  definitions: SourceControlDefinitionRegistry,
): RepositoryIdentity | null {
  if (identity === null || identity.origin === undefined) return identity;
  const { origin } = identity;
  const separator = origin.canonicalKey.indexOf("/");
  if (separator < 1 || separator === origin.canonicalKey.length - 1) return null;
  const path = origin.canonicalKey.slice(separator + 1);

  // The key can identify a public forge when the SSH remote names an alias.
  const keyUrl = `https://${origin.canonicalKey}`;
  const provider = origin.provider ?? definitions.recognizeRemote(keyUrl)?.kind;
  const web = webRemote(origin.webUrl);
  const remote = webRemote(origin.remoteUrl);
  const mountedPath =
    provider === "forgejo" && (remote === null || remote.origin === web?.origin)
      ? web?.pathname.replace(/^\/+|\/+$/g, "")
      : undefined;

  return {
    canonicalKey: origin.canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: origin.remoteUrl ?? keyUrl },
    displayName: mountedPath || (origin.displayName ?? path),
    ...(provider === undefined ? {} : { provider }),
    ...(origin.webUrl === undefined ? {} : { webUrl: origin.webUrl }),
    ...(identity.rootPath === undefined ? {} : { rootPath: identity.rootPath }),
  };
}
