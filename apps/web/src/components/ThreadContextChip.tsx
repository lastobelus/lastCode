import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationReadScope, type ThreadContextRecord } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useThreadSearch } from "~/state/queries";
import { useEnvironmentPresentation } from "~/state/presentation";
import { useEnvironmentScope } from "~/state/session";
import type { ThreadReferenceUnavailableReason } from "@t3tools/shared/composerContextReferences";

import { useProject, useThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  copyMarkdown?: string;
  unreadable?: boolean;
  unavailableReason?: ThreadReferenceUnavailableReason | null;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
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
  const metadataLookupResolved =
    metadata.mentionResolvedEnvironments?.includes(environmentId) === true &&
    metadata.mentionsTruncated !== true;
  const confirmedMissing = metadataLookupResolved && candidate === undefined;
  const title = shell?.title?.trim() || candidate?.title?.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            {...(props.unreadable || props.unavailableReason || confirmedMissing
              ? { state: "invalid" as const }
              : {})}
            render={<Link to="/$environmentId/$threadId" params={{ environmentId, threadId }} />}
            aria-label={`Thread, ${title}`}
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
      <TooltipPopup side="top">
        {props.unavailableReason === "permission-denied"
          ? "Check read permission for the source and selected machines, or remove the reference."
          : props.unavailableReason === "disconnected"
            ? "Check the connections to the source and selected machines to read this reference."
            : props.unavailableReason === "unsupported"
              ? "Check for server updates on the source and selected machines to read this reference."
              : props.unreadable
                ? "This thread can't be read from the selected machine. Check connections, read permissions and server updates, or remove the reference."
                : shell
                  ? "Open thread"
                  : candidate
                    ? [candidate.projectTitle, presentation?.entry.target.label]
                        .filter(Boolean)
                        .join(" · ")
                    : confirmedMissing
                      ? "This thread was not found in its source environment. Its saved title is shown."
                      : "Thread details are unavailable. Its saved title is shown; this does not mean the thread was deleted."}
      </TooltipPopup>
    </Tooltip>
  );
}
