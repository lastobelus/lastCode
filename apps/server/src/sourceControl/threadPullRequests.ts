import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";

import { builtInSourceControlDefinitions as sourceControlDefinitions } from "@t3tools/source-control-definitions/registry";

export { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadPullRequestChains,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlDefinitions);
