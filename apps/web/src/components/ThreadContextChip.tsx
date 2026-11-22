import type { AppRouter } from "~/router";
import { safeThreadRouteParams } from "~/threadRoutes";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationReadScope,
  type ThreadContextRecord,
  type ProjectId,
} from "@t3tools/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useGT } from "gt-react";
import { useThreadSearch } from "~/state/queries";
import { useEnvironmentPresentation } from "~/state/presentation";
import { useEnvironmentScope } from "~/state/session";
import type { ThreadReferenceUnavailableReason } from "@t3tools/shared/composerContextReferences";

import { resolveThreadOpenRoute } from "~/lib/sideChatPane";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useProject, useThreadShell } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadChipHoverCard } from "./ThreadChipHoverCard";
import { ThreadHoverCardPopup } from "./ThreadHoverCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  projectId?: ProjectId | null;
  copyMarkdown?: string;
  unreadable?: boolean;
  unavailableReason?: ThreadReferenceUnavailableReason | null;
}) {
  const gt = useGT();
  const { environmentId, threadId } = props.record;
  const params = safeThreadRouteParams(useRouter<AppRouter>(), { environmentId, threadId });
  const shell = useThreadShell({ environmentId, threadId });
  const lookup = useEnvironmentQuery(
    shell === null && props.projectId === undefined
      ? orchestrationEnvironment.threadLinkMetadata({
          environmentId,
          input: { threadIds: [threadId] },
        })
      : null,
  );
  const linkMetadata = lookup.data?.[threadId];
  const { presentation } = useEnvironmentPresentation(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canResolveMetadata =
    canRead &&
    presentation?.connection.phase === "connected" &&
    presentation.serverConfig?.environment.capabilities.universalThreadReferences === true;
  const metadata = useThreadSearch(canResolveMetadata ? [environmentId] : [], "", {
    mode: "thread-mention",
    threadIds: [threadId],
    titlesOnly: true,
  });
  const candidate = metadata.mentionCandidates?.find(
    (item) => item.environmentId === environmentId && item.id === threadId,
  );
  const thread = shell ?? candidate ?? null;
  const metadataLookupResolved =
    metadata.mentionResolvedEnvironments?.includes(environmentId) === true &&
    metadata.mentionsTruncated !== true;
  const confirmedMissing =
    shell === null &&
    props.projectId === undefined &&
    linkMetadata === undefined &&
    metadataLookupResolved &&
    candidate === undefined;
  const projectId =
    shell?.projectId ?? props.projectId ?? linkMetadata?.projectId ?? candidate?.projectId;
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);
  const title =
    shell?.title?.trim() ||
    linkMetadata?.title.trim() ||
    candidate?.title?.trim() ||
    props.record.title;
  const navigate = useNavigate();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(!params || props.unreadable || props.unavailableReason || confirmedMissing
              ? { state: "invalid" as const }
              : {})}
            render={
              params ? (
                <Link
                  to="/$environmentId/$threadId"
                  params={params}
                  onClick={(event) => {
                    if (thread?.lineage.sideChat !== true || event.button !== 0) return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    // A primary click opens a side chat beside its parent.
                    event.preventDefault();
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(resolveThreadOpenRoute(params, thread)),
                    });
                  }}
                  draggable={false}
                />
              ) : (
                <span />
              )
            }
            aria-label={gt("Thread, {title}", { title })}
            data-markdown-copy={props.copyMarkdown}
            className="no-underline"
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      {props.unavailableReason || props.unreadable || shell === null ? (
        <TooltipPopup side="top">
          {props.unavailableReason === "permission-denied"
            ? gt(
                "Check read permission for the source and selected machines, or remove the reference.",
              )
            : props.unavailableReason === "disconnected"
              ? gt(
                  "Check the connections to the source and selected machines to read this reference.",
                )
              : props.unavailableReason === "unsupported"
                ? gt(
                    "Check for server updates on the source and selected machines to read this reference.",
                  )
                : props.unreadable
                  ? gt(
                      "This thread can't be read from the selected machine. Check connections, read permissions and server updates, or remove the reference.",
                    )
                  : linkMetadata
                    ? gt("Open thread")
                    : candidate
                      ? [candidate.projectTitle, presentation?.entry.target.label]
                          .filter(Boolean)
                          .join(" · ")
                      : confirmedMissing
                        ? gt(
                            "This thread was not found in its source environment. Its saved title is shown.",
                          )
                        : gt(
                            "Thread details are unavailable. Its saved title is shown; this does not mean the thread was deleted.",
                          )}
        </TooltipPopup>
      ) : (
        <ThreadHoverCardPopup side="top">
          <ThreadChipHoverCard title={title} project={project} shell={shell} unreadable={false} />
        </ThreadHoverCardPopup>
      )}
    </Tooltip>
  );
}
