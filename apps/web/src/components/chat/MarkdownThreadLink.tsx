import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatThreadLink,
  resolveThreadLinkReference,
  type ThreadLinkReference,
} from "@t3tools/shared/threadLinks";
import { Link } from "@tanstack/react-router";
import { MessageSquareTextIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useProject } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { ProjectFavicon } from "../ProjectFavicon";

export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: ThreadLinkReference;
  readonly messageEnvironmentId?: EnvironmentId | undefined;
  readonly label: string;
}) {
  const {
    threadId: linkedThreadId,
    environmentId: linkedEnvironmentId,
    version,
    legacyThreadId,
  } = props.reference;
  const messageEnvironmentId = props.messageEnvironmentId;
  const resolvedAtom = useMemo(
    () =>
      Atom.make((get) =>
        resolveThreadLinkReference(
          { threadId: linkedThreadId, environmentId: linkedEnvironmentId, version, legacyThreadId },
          (threadId, environmentId) => {
            const owner = environmentId ?? messageEnvironmentId;
            return owner === undefined
              ? undefined
              : (get(environmentThreadShells.threadShellAtom(scopeThreadRef(owner, threadId))) ??
                  undefined);
          },
        ),
      ),
    [linkedThreadId, linkedEnvironmentId, version, legacyThreadId, messageEnvironmentId],
  );
  const resolved = useAtomValue(resolvedAtom);
  const thread = resolved.value;
  const threadId = resolved.threadId;
  const environmentId = resolved.environmentId ?? props.messageEnvironmentId ?? props.environmentId;
  const project = useProject(
    thread === undefined ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const title = thread?.title.trim() || props.label;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId }}
      title={thread === undefined ? "Thread no longer available" : project?.title}
      data-markdown-copy={formatThreadLink(threadId, title, environmentId)}
    >
      <span
        className="ms-[0.25em] me-[0.2em] inline-flex size-[14px] [vertical-align:-0.125em]"
        aria-hidden
      >
        {project === null ? (
          <MessageSquareTextIcon className="block size-full shrink-0" />
        ) : (
          <ProjectFavicon project={project} className="size-full" />
        )}
      </span>
      {title}
    </Link>
  );
}
