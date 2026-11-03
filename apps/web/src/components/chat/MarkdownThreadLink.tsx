import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatThreadLink,
  resolveThreadLinkReference,
  guessThreadLinkRef,
  unknownThreadLinkLabel,
  type ThreadLinkReference,
} from "@t3tools/shared/threadLinks";
import { Atom } from "effect/reactivity";

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
    const resolved = resolveThreadLinkReference(
      { threadId: linkedThreadId, environmentId: linkedEnvironmentId, version, legacyThreadId },
      (threadId, environmentId) => {
        const owner = environmentId ?? messageEnvironmentId;
        return (
          get(environmentThreadShells.threadShellAtom(scopeThreadRef(owner, threadId))) ?? undefined
        );
      },
    );
    if (resolved.value !== undefined || version === 2) return resolved;
    const target = guessThreadLinkRef(
      {
        environmentId: linkedEnvironmentId ?? null,
        threadId: linkedThreadId,
        version,
        legacyThreadId,
      },
      get(environmentThreadShells.threadRefsAtom),
    );
    return target === null
      ? resolved
      : { ...target, value: get(environmentThreadShells.threadShellAtom(target)) ?? undefined };
  });
  const resolved = useAtomValue(resolvedAtom);
  const thread = resolved.value;
  const environmentId = resolved.environmentId ?? messageEnvironmentId;
  if (thread === undefined) {
    const unknown = unknownThreadLinkLabel(
      { environmentId: resolved.environmentId ?? null, threadId: resolved.threadId },
      messageEnvironmentId,
    );
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip record={{ ...ref, title }} copyMarkdown={formatThreadLink(ref, title)} />
  );
}
