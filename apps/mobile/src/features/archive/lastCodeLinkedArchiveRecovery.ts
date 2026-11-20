import {
  buildLinkedArchiveRecovery,
  LINKED_ARCHIVE_NO_ACTIVITY,
  LINKED_ARCHIVE_RETRY_ARCHIVE,
  LINKED_ARCHIVE_RETRY_RESTORE,
  LINKED_ARCHIVE_STATUS_LABEL,
  resolveThreadArchiveFamily,
} from "@t3tools/client-runtime/state/thread-archive";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { requestLastCodeMobileArchiveDialog } from "./lastCodeMobileArchiveDialogState";
import { refreshArchivedThreadsForEnvironment } from "./useArchivedThreadSnapshots";

export const LINKED_ARCHIVE_STATUS_ACTION = "linked-archive-status";

export async function showLastCodeLinkedArchiveStatus({
  environmentId,
  threadId,
}: ScopedThreadRef) {
  const title = m(LINKED_ARCHIVE_STATUS_LABEL);
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, m(msg("This connection cannot change threads.")));
    return;
  }
  const target = { environmentId, input: { threadId } };
  const load = () =>
    runAtomCommand(appAtomRegistry, threadEnvironment.loadArchiveFamily, target, {
      reportFailure: false,
    });
  const reportFailure = (error: unknown) =>
    Dialog.alert(title, error instanceof Error ? error.message : m(msg("An error occurred.")));
  try {
    const result = await load();
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    const recovery = buildLinkedArchiveRecovery(result.value, m);
    if (!recovery) {
      Dialog.alert(title, m(LINKED_ARCHIVE_NO_ACTIVITY));
      return;
    }
    const status = recovery.machines.map(({ label, status }) => `${label} · ${status}`).join("\n");
    const confirm = (includeTypedIn: boolean) => {
      const review = resolveThreadArchiveFamily(
        {
          ...result.value,
          archivePreview: undefined,
          threads: [],
          children: [],
          activeThreadIds: [],
          unreadThreadIds: [],
          canStopAndArchive: true,
          linkedArchivePreview: recovery.reviewPreviews,
        },
        m,
        ({ environmentId, projectId }) =>
          appAtomRegistry.get(
            environmentProjects.projectAtom(scopeProjectRef(environmentId, projectId)),
          )?.title ?? projectId,
        includeTypedIn,
      );
      return {
        ...review,
        blocked: !recovery.canRetry,
        message: recovery.reviewPreviews.length ? [status, review.message].join("\n\n") : status,
        confirmLabel:
          review.disposition === "stop_and_archive"
            ? review.confirmLabel
            : m(
                recovery.operation === "archive"
                  ? LINKED_ARCHIVE_RETRY_ARCHIVE
                  : LINKED_ARCHIVE_RETRY_RESTORE,
              ),
      };
    };
    const retry = async (includeTypedIn: boolean) => {
      try {
        const latest = await load();
        if (latest._tag === "Failure") throw squashAtomCommandFailure(latest);
        const operation = latest.value.linkedArchiveOperation;
        if (
          operation?.sourceArchiveCommandId !== recovery.sourceArchiveCommandId ||
          operation.operation !== recovery.operation
        ) {
          throw new Error(
            m(msg("The conversation family changed. Review the archive confirmation again.")),
          );
        }
        const retried = await (recovery.operation === "restore"
          ? runAtomCommand(
              appAtomRegistry,
              threadEnvironment.unarchive,
              {
                environmentId,
                input: {
                  threadId,
                  expectedLinkedArchiveCommandId: recovery.sourceArchiveCommandId,
                },
              },
              { reportFailure: false },
            )
          : runAtomCommand(
              appAtomRegistry,
              threadEnvironment.archive,
              {
                environmentId,
                input: {
                  threadId,
                  childDisposition: confirm(includeTypedIn).disposition,
                  linkedArchiveSelection: recovery.selection(includeTypedIn),
                  expectedLinkedArchiveCommandId: recovery.sourceArchiveCommandId,
                },
              },
              { reportFailure: false },
            ));
        if (retried._tag === "Failure") throw squashAtomCommandFailure(retried);
        refreshArchivedThreadsForEnvironment(environmentId);
      } catch (error) {
        reportFailure(error);
      }
    };
    const initial = confirm(false);
    if (initial.canIncludeTypedIn && recovery.canRetry) {
      const choice = await requestLastCodeMobileArchiveDialog({ title, confirm });
      if (choice !== null && choice !== "review") await retry(choice.includeTypedIn);
    } else {
      Dialog.alert(
        title,
        initial.message,
        recovery.canRetry
          ? [
              { text: m(msg("Cancel")), style: "cancel" },
              { text: initial.confirmLabel, onPress: () => void retry(false) },
            ]
          : undefined,
      );
    }
  } catch (error) {
    reportFailure(error);
  }
}
