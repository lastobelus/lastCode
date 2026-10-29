import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
} from "@t3tools/client-runtime/composerThreadItems";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  PullRequestListInput,
  ServerProvider,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "@t3tools/shared/composerPullRequestMatches";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";

import type { ComposerTrigger } from "../../composer-logic";
import type { DraftId } from "../../composerDraftStore";
import { basenameOfPath } from "../../pierre-icons";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useThreadShells } from "~/state/entities";
import {
  useEnvironmentIdentities,
  useEnvironmentMachines,
  useEnvironments,
} from "~/state/environments";
import { useEnvironmentsWithScope } from "~/state/session";
import { offersLinkedEnvironmentsAtom } from "~/state/peerLinks";
import {
  pullRequestEnvironment,
  usePullRequestList,
  type EnvironmentQueryTarget,
} from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useComposerPathSearch, useDebouncedValue, useThreadSearch } from "~/state/queries";
import {
  matchesPullRequestQuery,
  rankPullRequestMatches,
} from "../pullRequest/pullRequestList.logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  searchSlashCommandItems,
  slashCommandItemsForPromptPosition,
} from "./composerSlashCommandSearch";

const COMPOSER_PULL_REQUEST_LIST_LIMIT = 99;
const COMPOSER_PULL_REQUEST_RESULT_LIMIT = 12;
const EMPTY_PULL_REQUEST_LIST_TARGETS: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>> =
  [];

/** Builds the @, /, $ and # suggestion lists, running the searches each trigger needs. */
export function useComposerMenuItems({
  composerTrigger,
  environmentId,
  gitCwd,
  activeThreadId,
  pullRequestProjectId,
  pullRequestRepository,
  threadPullRequests,
  planModeUiEnabled,
  sideChatAvailable,
  sideChatDisabledReason,
  threadAnnotationsSupported,
  compactSlashCommandAvailable,
  selectedProvider,
  selectedProviderSkills,
  selectedProviderSlashCommands,
  showSkillsInSlashMenu,
  questionAttachmentTarget,
}: {
  readonly composerTrigger: ComposerTrigger | null;
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly pullRequestProjectId: ProjectId | null;
  readonly pullRequestRepository: string | null;
  readonly threadPullRequests: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly planModeUiEnabled: boolean;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly threadAnnotationsSupported: boolean;
  readonly compactSlashCommandAvailable: boolean;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedProviderSkills: ServerProvider["skills"];
  readonly selectedProviderSlashCommands: ServerProvider["slashCommands"];
  readonly showSkillsInSlashMenu: boolean;
  readonly questionAttachmentTarget: DraftId | null;
}) {
  // Thread mentions rank by recency as of when the composer mounted.
  const [now] = useState(() => Date.now());
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const pullRequestTriggerQuery =
    composerTrigger?.kind === "pull-request" ? composerTrigger.query : "";
  const pullRequestTextQuery =
    composerTriggerKind === "pull-request" &&
    pullRequestTriggerQuery.length > 0 &&
    !/^\d+$/u.test(pullRequestTriggerQuery)
      ? pullRequestTriggerQuery
      : null;
  const debouncedPullRequestTextQuery = useDebouncedValue(pullRequestTextQuery, 180);
  const settledPullRequestTextQuery =
    pullRequestTextQuery === debouncedPullRequestTextQuery ? pullRequestTextQuery : null;
  const isPathTrigger = composerTriggerKind === "path";
  const environmentThreadShells = useThreadShells(isPathTrigger);
  const { environments } = useEnvironments();
  const canReadEnvironment = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const destinationSupportsReferences = environments.some(
    (environment) =>
      environment.environmentId === environmentId &&
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.universalThreadReferences === true,
  );
  const mentionSources = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      canReadEnvironment.has(environment.environmentId) &&
      environment.serverConfig?.environment.capabilities.universalThreadReferences === true &&
      (environment.environmentId === environmentId || destinationSupportsReferences),
  );
  const allowedThreadEnvironments = new Set(
    environments
      .filter(
        (environment) =>
          environment.connection.phase === "connected" &&
          canReadEnvironment.has(environment.environmentId) &&
          (environment.environmentId === environmentId ||
            (destinationSupportsReferences &&
              environment.serverConfig?.environment.capabilities.universalThreadReferences ===
                true)),
      )
      .map((environment) => environment.environmentId),
  );
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const mentionSearch = useThreadSearch(
    isPathTrigger ? mentionSources.map(({ environmentId: id }) => id) : [],
    pathTriggerQuery,
    {
      mode: "thread-mention",
      titlesOnly: true,
      environmentLabels: Object.fromEntries(environmentLabels),
    },
  );
  const hasUnsearchedEnvironments = environments.some(
    (environment) =>
      environment.entry.enabled &&
      !mentionSources.some((source) => source.environmentId === environment.environmentId),
  );
  // The user's machines feed `@` machine matches; the catalog summary is cheap and stable.
  const environmentIdentities = useEnvironmentIdentities();
  const environmentMachines = useEnvironmentMachines();
  const offersMachines = useAtomValue(offersLinkedEnvironmentsAtom(environmentId));
  const mentionableEnvironments = environmentIdentities.map((identity) => ({
    ...identity,
    machine: environmentMachines.get(identity.environmentId) ?? ("server" as const),
  }));
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const pullRequestListTargets =
    composerTriggerKind !== "pull-request" ||
    pullRequestProjectId === null ||
    (pullRequestTextQuery !== null && settledPullRequestTextQuery === null)
      ? EMPTY_PULL_REQUEST_LIST_TARGETS
      : [
          {
            environmentId,
            input: {
              state: "all" as const,
              projectId: pullRequestProjectId,
              limit: COMPOSER_PULL_REQUEST_LIST_LIMIT,
              ...(settledPullRequestTextQuery === null
                ? {}
                : { query: settledPullRequestTextQuery }),
            },
          },
        ];
  const pullRequestLookup = usePullRequestList(pullRequestListTargets);
  const pullRequestTriggerNumber = (() => {
    if (composerTrigger?.kind !== "pull-request" || composerTrigger.query.length === 0) {
      return null;
    }
    const number = Number(composerTrigger.query);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  })();
  const debouncedPullRequestNumber = useDebouncedValue(pullRequestTriggerNumber, 180);
  const settledPullRequestNumber =
    pullRequestTriggerNumber === debouncedPullRequestNumber ? pullRequestTriggerNumber : null;
  const recentHasExactPullRequest =
    settledPullRequestNumber !== null &&
    pullRequestLookup.data?.entries.some(
      (entry) =>
        entry.projectId === pullRequestProjectId &&
        entry.repository.trim().toLowerCase() === pullRequestRepository?.trim().toLowerCase() &&
        entry.number === settledPullRequestNumber,
    ) === true;
  const exactPullRequestLookup = useEnvironmentQuery(
    settledPullRequestNumber === null ||
      pullRequestProjectId === null ||
      pullRequestRepository === null ||
      recentHasExactPullRequest
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: {
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            number: settledPullRequestNumber,
          },
        }),
  );

  const linkedPullRequests =
    pullRequestProjectId === null
      ? []
      : composerPullRequestsFromLinks(threadPullRequests ?? [], pullRequestProjectId);

  const items = ((): ComposerCommandItem[] => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return [
        ...matchComposerThreadItems({
          shells: environmentThreadShells,
          environmentId,
          allowedEnvironmentIds: allowedThreadEnvironments,
          environmentLabels,
          excludeThread:
            activeThreadId === null ? null : { environmentId, threadId: activeThreadId },
          candidates: mentionSearch.mentionCandidates ?? [],
          query: composerTrigger.query,
          now,
        }),
        // An answer to an agent's question carries thread links, not machines.
        ...(questionAttachmentTarget === null && offersMachines
          ? matchComposerEnvironmentItems({
              environments: mentionableEnvironments,
              environmentId,
              query: composerTrigger.query,
            })
          : []),
        ...workspaceEntries.entries.map((entry) => ({
          id: `path:${entry.kind}:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          pathKind: entry.kind,
          searchTarget: workspaceEntries.searchedTarget,
          label: basenameOfPath(entry.path),
          description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
        })),
      ];
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(threadAnnotationsSupported
          ? ([
              {
                id: "slash:annotate",
                type: "slash-command",
                command: "annotate",
                label: "/annotate",
                description: "Add or edit this thread's annotation",
              },
            ] as const)
          : []),
        ...(planModeUiEnabled
          ? ([
              {
                id: "slash:plan",
                type: "slash-command",
                command: "plan",
                label: "/plan",
                description: "Switch this thread into plan mode",
              },
              {
                id: "slash:default",
                type: "slash-command",
                command: "default",
                label: "/default",
                description: "Switch this thread back to normal build mode",
              },
            ] as const)
          : []),
        ...(sideChatAvailable
          ? ([
              {
                id: "slash:side",
                type: "slash-command",
                command: "side",
                label: "/side",
                description: sideChatDisabledReason ?? "Ask a side question in a new side chat",
              },
              {
                id: "slash:btw",
                type: "slash-command",
                command: "btw",
                label: "/btw",
                description: sideChatDisabledReason ?? "Same as /side",
              },
            ] as const)
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const slashMenuSkills = getProviderSkillsForSlashMenu(
        selectedProviderSkills,
        showSkillsInSlashMenu,
      );
      const providerSlashCommandItems = getProviderSlashCommandsForSlashMenu(
        selectedProviderSlashCommands,
        slashMenuSkills,
      ).map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: command.description ?? command.input?.hint ?? "Run provider command",
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = slashMenuSkills.map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: `/skill:${skill.name}`,
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : ""),
      }));
      const visibleProviderSlashCommandItems = providerSlashCommandItems.filter(
        (item) => item.command.name !== "compact" || compactSlashCommandAvailable,
      );
      const slashCommandItems = slashCommandItemsForPromptPosition(
        [...builtInSlashCommandItems, ...visibleProviderSlashCommandItems, ...skillItems],
        composerTrigger.rangeStart === 0,
      );
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    if (
      composerTrigger.kind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null
    ) {
      const exactPullRequest =
        exactPullRequestLookup.data?.number === pullRequestTriggerNumber
          ? [exactPullRequestLookup.data]
          : [];
      const matches = /^\d*$/u.test(composerTrigger.query)
        ? filterComposerPullRequestMatches({
            entries: [...exactPullRequest, ...(pullRequestLookup.data?.entries ?? [])],
            linked: linkedPullRequests,
            projectId: pullRequestProjectId,
            repository: pullRequestRepository,
            query: composerTrigger.query,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
          })
        : withLinkedComposerPullRequestsFirst({
            matches: rankPullRequestMatches(
              (pullRequestLookup.data?.entries ?? []).filter((entry) => {
                if (
                  entry.projectId !== pullRequestProjectId ||
                  entry.repository.trim().toLowerCase() !==
                    pullRequestRepository.trim().toLowerCase()
                ) {
                  return false;
                }
                const provider = pullRequestLookup.data?.providers.find(
                  (candidate) => candidate.host === entry.host,
                );
                return (
                  provider?.searchesOnHost === true ||
                  matchesPullRequestQuery(entry, composerTrigger.query)
                );
              }),
              composerTrigger.query,
            ),
            linked: linkedPullRequests,
            query: composerTrigger.query,
            limit: COMPOSER_PULL_REQUEST_RESULT_LIMIT,
          });
      return matches.map((pullRequest) => ({
        id: `pull-request:${pullRequest.projectId}:${pullRequest.repository}:${pullRequest.number}`,
        type: "pull-request",
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
        },
        label: `#${pullRequest.number}`,
        description:
          pullRequest.repository.trim().toLowerCase() === pullRequestRepository.trim().toLowerCase()
            ? pullRequest.title
            : `${pullRequest.repository} · ${pullRequest.title}`,
      }));
    }
    return [];
  })();
  const isLoading =
    (isPathTrigger && mentionSearch.isPending) ||
    (composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending) ||
    (composerTriggerKind === "pull-request" &&
      pullRequestProjectId !== null &&
      pullRequestRepository !== null &&
      (pullRequestLookup.isPending ||
        pullRequestTextQuery !== debouncedPullRequestTextQuery ||
        pullRequestTriggerNumber !== debouncedPullRequestNumber ||
        exactPullRequestLookup.isPending));
  const searchStatus =
    !isPathTrigger || pathTriggerQuery.length === 0
      ? null
      : pathTriggerQuery.trim().length < 2
        ? "Type at least two characters to search more threads."
        : hasUnsearchedEnvironments || (mentionSearch.mentionFailures?.length ?? 0) > 0
          ? "Some environments could not be searched. Results may be incomplete."
          : mentionSearch.mentionsTruncated
            ? "More threads match than can be shown. Add to your search to narrow the results."
            : null;
  const emptyState = (() => {
    if (searchStatus !== null) return searchStatus;
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "pull-request") {
      if (pullRequestProjectId === null || pullRequestRepository === null) {
        return "Pull requests are not available for this project.";
      }
      if (
        pullRequestLookup.error !== null ||
        pullRequestLookup.data?.errors.some((error) => error.projectId === pullRequestProjectId)
      ) {
        return "Pull requests could not be read for this project.";
      }
      return composerTrigger?.query
        ? `No pull request matches ${composerTrigger.query}.`
        : "No pull requests found in this repository.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  })();

  return { items, isLoading, emptyState, searchStatus };
}
