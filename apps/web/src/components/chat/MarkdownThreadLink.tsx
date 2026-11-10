import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  resolveThreadLinkReference,
  threadLinkCandidates,
  unknownThreadLinkLabel,
  type ThreadLinkReference,
} from "@t3tools/shared/threadLinks";
import { AsyncResult, Atom } from "effect/reactivity";

import { configuredHostedAppUrl } from "../../hostedPairing";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadShells } from "../../state/threads";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: ThreadLinkReference;
  readonly messageEnvironmentId?: EnvironmentId | undefined;
  readonly label: string | null;
}) {
  const {
    threadId: linkedThreadId,
    environmentId: linkedEnvironmentId,
    version,
    legacyThreadId,
  } = props.reference;
  const messageEnvironmentId = props.messageEnvironmentId ?? props.environmentId;
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
  if (resolved.missing && metadata === undefined) {
    const unknown = unknownThreadLinkLabel(
      { environmentId: resolved.environmentId ?? null, threadId: resolved.threadId },
      messageEnvironmentId,
    );
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId, threadId: resolved.threadId };
  const title = metadata?.title.trim() || props.label || "Thread";
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      projectId={metadata?.projectId ?? null}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
