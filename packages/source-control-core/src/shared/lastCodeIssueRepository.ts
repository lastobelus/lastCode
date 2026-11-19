import type { RepositoryIdentity } from "@t3tools/contracts";

import type { SourceControlDefinitionRegistry } from "./definition.ts";

/** Use the checkout's own repository for issues, including when upstream supplies its identity. */
export function selectLastCodeIssueRepository(
  identity: RepositoryIdentity | null,
  definitions: SourceControlDefinitionRegistry,
): RepositoryIdentity | null {
  if (identity === null || identity.origin === undefined) return identity;
  const { origin } = identity;
  const separator = origin.canonicalKey.indexOf("/");
  if (separator < 1 || separator === origin.canonicalKey.length - 1) return null;
  const host = origin.canonicalKey.slice(0, separator);
  const path = origin.canonicalKey.slice(separator + 1);

  // The key already resolves SSH aliases. A self-hosted origin on the same host can use the
  // provider discovered for the canonical remote.
  const keyUrl = `https://${origin.canonicalKey}`;
  const kind = definitions.recognizeRemote(keyUrl)?.kind;
  const provider =
    kind === "unknown" && host === identity.canonicalKey.split("/", 1)[0]
      ? identity.provider
      : kind;

  return {
    canonicalKey: origin.canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: origin.remoteUrl ?? keyUrl },
    displayName: origin.displayName ?? path,
    ...(provider === undefined ? {} : { provider }),
  };
}
