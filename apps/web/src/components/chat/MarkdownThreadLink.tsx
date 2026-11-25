import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  resolveThreadLinkReference,
  threadLinkCandidates,
  type ThreadLinkReference,
} from "@t3tools/shared/threadLinks";
import { unknownThreadLinkLabel } from "@t3tools/shared/threadLinksCopy";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import { MessagesSquareIcon } from "lucide-react";

import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { openLinkedThreadRead } from "../../lib/sideChatPane";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { environmentSummaries } from "../../state/presentation";
import { environmentThreadShells } from "../../state/threads";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  /** The thread the link is written in; a linked environment's thread can open in its right panel. */
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly reference: ThreadLinkReference;
  readonly label: string | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const trigger = useSideThreadTrigger();
  const panelRef = props.threadRef ?? null;
  const {
    threadId: linkedThreadId,
    environmentId: linkedEnvironmentId,
    version,
    legacyThreadId,
  } = props.reference;
  const messageEnvironmentId = props.environmentId;
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const linkedLabel = useLinkedEnvironments(
    linkedEnvironmentId === undefined ||
      linkedEnvironmentId === messageEnvironmentId ||
      connectedEnvironmentIds.includes(linkedEnvironmentId)
      ? null
      : messageEnvironmentId,
    linkedEnvironmentId,
  ).get(linkedEnvironmentId ?? messageEnvironmentId);
  const viaLinkedEnvironment = linkedLabel === undefined ? undefined : linkedEnvironmentId;

  const resolvedAtom = Atom.make((get) => {
    const reference = {
      threadId: linkedThreadId,
      environmentId: linkedEnvironmentId,
      version,
      legacyThreadId,
    };
    const link = { ...reference, environmentId: linkedEnvironmentId ?? null };
    const candidates = threadLinkCandidates(link, messageEnvironmentId);
    let settled = true;
    const resolved = resolveThreadLinkReference(reference, (threadId, environmentId) => {
      const owner = environmentId ?? messageEnvironmentId;
      const shell = get(environmentThreadShells.threadShellAtom(scopeThreadRef(owner, threadId)));
      if (shell !== null) return shell;
      // A linked machine without a client connection is read through the message's environment.
      if (owner === viaLinkedEnvironment) return undefined;
      const saved = get(environmentSummaries.identitiesAtom).some(
        (environment) => environment.environmentId === owner,
      );
      if (!saved) return undefined;
      const lookup = get(
        orchestrationEnvironment.threadLinkMetadata({
          environmentId: owner,
          input: {
            threadIds: candidates
              .filter((candidate) => candidate.environmentId === owner)
              .map((candidate) => candidate.threadId),
          },
        }),
      );
      settled = settled && lookup._tag === "Success" && !lookup.waiting;
      return AsyncResult.getOrElse(lookup, () => null)?.[threadId];
    });
    const missing = resolved.value === undefined && settled;
    if (!missing || version === 2) return { ...resolved, missing };
    const target = guessThreadLinkRef(
      link,
      get(environmentThreadShells.threadRefsAtom).filter(
        (ref) => !candidates.some((candidate) => candidate.environmentId === ref.environmentId),
      ),
    );
    return target === null
      ? { ...resolved, missing }
      : {
          ...target,
          value: get(environmentThreadShells.threadShellAtom(target)) ?? undefined,
          missing,
        };
  });
  const resolved = useAtomValue(resolvedAtom);
  const metadata = resolved.value;
  const environmentId = resolved.environmentId ?? messageEnvironmentId;
  const ref = { environmentId, threadId: resolved.threadId };

  if (linkedLabel !== undefined && environmentId === viaLinkedEnvironment) {
    const knownTitle = props.label ?? metadata?.title ?? null;
    const title = knownTitle ?? gt("Thread on {label}", { label: linkedLabel });
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextChip
              kind="thread"
              render={
                <button
                  type="button"
                  {...trigger(
                    (intent) =>
                      openLinkedThreadRead({
                        panelRef,
                        target: {
                          viaEnvironmentId: messageEnvironmentId,
                          ...ref,
                          label: linkedLabel,
                          title: knownTitle,
                        },
                        intent,
                        navigate,
                      }),
                    // Outside a thread there is no panel to read it in.
                    { panel: panelRef !== null },
                  )}
                />
              }
              aria-label={gt("Thread, {title}", { title })}
            >
              <MessagesSquareIcon />
              <ContextChipLabel>{title}</ContextChipLabel>
            </ContextChip>
          }
        />
        <TooltipPopup side="top">
          {gt("Read the thread on {label}", { label: linkedLabel })}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (resolved.missing && metadata === undefined) {
    const unknown = unknownThreadLinkLabel(
      { environmentId: resolved.environmentId ?? null, threadId: resolved.threadId },
      messageEnvironmentId,
      messages,
    );
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const title = metadata?.title.trim() || props.label || gt("Thread");
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      projectId={metadata?.projectId ?? null}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
