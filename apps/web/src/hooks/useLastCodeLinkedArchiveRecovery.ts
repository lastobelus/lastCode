import {
  buildLinkedArchiveRecoveries,
  LINKED_ARCHIVE_STATUS_LABEL,
} from "@t3tools/client-runtime/state/thread-archive";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { requestThreadArchiveDialog } from "../components/ThreadArchiveDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { readEnvironmentSupportsArchiveFamilies } from "../state/entities";
import { readEnvironmentScope } from "../state/session";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export const LINKED_ARCHIVE_STATUS_ACTION = "linked-archive-status";

export function linkedArchiveStatusMenuItem(
  environmentId: EnvironmentId,
): readonly ContextMenuItem<typeof LINKED_ARCHIVE_STATUS_ACTION>[] {
  if (
    !readEnvironmentSupportsArchiveFamilies(environmentId) ||
    !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
  )
    return [];
  return [{ id: LINKED_ARCHIVE_STATUS_ACTION, label: m(LINKED_ARCHIVE_STATUS_LABEL) }];
}

function reportLinkedArchiveFailure(error: unknown) {
  const description = error instanceof Error ? error.message : m(msg("An error occurred."));
  toastManager.add(
    stackedThreadToast({ type: "error", title: m(LINKED_ARCHIVE_STATUS_LABEL), description }),
  );
  return description;
}

export function useLastCodeLinkedArchiveRecovery() {
  const load = useOrchestrationCommand(threadEnvironment.loadArchiveFamily, {
    reportFailure: false,
  });
  const archive = useOrchestrationCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, { reportFailure: false });
  return async ({ environmentId, threadId }: ScopedThreadRef) => {
    const target = { environmentId, input: { threadId } };
    const result = await load(target);
    if (result._tag === "Failure") {
      reportLinkedArchiveFailure(squashAtomCommandFailure(result));
      return;
    }
    const recoveries = buildLinkedArchiveRecoveries(result.value, m);
    await requestThreadArchiveDialog({
      title: m(LINKED_ARCHIVE_STATUS_LABEL),
      family: {
        threads: [],
        children: [],
        activeThreadIds: [],
        unreadThreadIds: [],
        protectedChildThreadIds: [],
        canStopAndArchive: true,
      },
      recoveries,
      submit: async (childDisposition, includeTypedIn, recovery) => {
        if (!recovery?.canRetry) return m(msg("An error occurred."));
        const latest = await load(target);
        if (latest._tag === "Failure") {
          return reportLinkedArchiveFailure(squashAtomCommandFailure(latest));
        }
        if (
          !latest.value.linkedArchiveOperations?.some(
            (operation) =>
              operation.sourceArchiveCommandId === recovery.sourceArchiveCommandId &&
              operation.operation === recovery.operation,
          )
        ) {
          return reportLinkedArchiveFailure(
            new Error(
              m(msg("The conversation family changed. Review the archive confirmation again.")),
            ),
          );
        }
        const retried = await (recovery.operation === "restore"
          ? unarchive({
              environmentId,
              input: { threadId, expectedLinkedArchiveCommandId: recovery.sourceArchiveCommandId },
            })
          : archive({
              environmentId,
              input: {
                threadId,
                childDisposition,
                linkedArchiveSelection: recovery.selection(includeTypedIn === true),
                expectedLinkedArchiveCommandId: recovery.sourceArchiveCommandId,
              },
            }));
        if (retried._tag === "Failure") {
          return reportLinkedArchiveFailure(squashAtomCommandFailure(retried));
        }
        refreshArchivedThreadsForEnvironment(environmentId);
        return null;
      },
    });
  };
}
