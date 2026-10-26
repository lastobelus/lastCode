import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatThreadLink,
  resolveThreadLinkReference,
  resolveThreadLinkRef,
  type ThreadLinkReference,
} from "@t3tools/shared/threadLinks";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../../state/threads";
import { ThreadContextChip } from "../ThreadContextChip";

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
  const resolvedAtom = Atom.make((get) => {
    const resolved = resolveThreadLinkReference(
      { threadId: linkedThreadId, environmentId: linkedEnvironmentId, version, legacyThreadId },
      (threadId, environmentId) => {
        const owner = environmentId ?? messageEnvironmentId;
        return owner === undefined
          ? undefined
          : (get(environmentThreadShells.threadShellAtom(scopeThreadRef(owner, threadId))) ??
              undefined);
      },
    );
    if (resolved.value !== undefined || linkedEnvironmentId !== undefined) return resolved;
    const target = resolveThreadLinkRef(
      scopeThreadRef(messageEnvironmentId ?? props.environmentId, linkedThreadId),
      get(environmentThreadShells.threadRefsAtom),
    );
    return target === null
      ? resolved
      : { ...target, value: get(environmentThreadShells.threadShellAtom(target)) ?? undefined };
  });
  const resolved = useAtomValue(resolvedAtom);
  const thread = resolved.value;
  const threadId = resolved.threadId;
  const environmentId = resolved.environmentId ?? props.messageEnvironmentId ?? props.environmentId;
  const title = thread?.title.trim() || props.label;
  return (
    <ThreadContextChip
      record={{ environmentId, threadId, title: props.label }}
      copyMarkdown={formatThreadLink(threadId, title, environmentId)}
    />
  );
}
