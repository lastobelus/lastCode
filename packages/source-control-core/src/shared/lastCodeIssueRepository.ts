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
  const path = origin.canonicalKey.slice(separator + 1);

  // The key can identify a public forge when the SSH remote names an alias.
  const keyUrl = `https://${origin.canonicalKey}`;
  const provider = origin.provider ?? definitions.recognizeRemote(keyUrl)?.kind;

  return {
    canonicalKey: origin.canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: origin.remoteUrl ?? keyUrl },
    displayName: origin.displayName ?? path,
    ...(provider === undefined ? {} : { provider }),
    ...(origin.webUrl === undefined ? {} : { webUrl: origin.webUrl }),
    ...(identity.rootPath === undefined ? {} : { rootPath: identity.rootPath }),
  };
}
