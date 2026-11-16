import type { AtomCommand, AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  consultThreadArchiveAgent,
  resolveThreadArchiveFamily,
  threadArchiveConsultationUnavailableReason,
  THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE,
} from "@t3tools/client-runtime/state/thread-archive";
import type {
  ScopedThreadRef,
  ThreadArchiveChildDisposition,
  ThreadArchiveConsultationTarget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells, type threadEnvironment } from "../../state/threads";

type CommandRunner<C> =
  C extends AtomCommand<infer W, infer A, infer E>
    ? (input: W) => Promise<AtomCommandResult<A, E>>
    : never;

export async function prepareLastCodeMobileThreadArchive(
  thread: EnvironmentThreadShell,
  ports: {
    loadArchiveFamily: CommandRunner<typeof threadEnvironment.loadArchiveFamily>;
    sendArchiveQuestion: CommandRunner<typeof threadEnvironment.startTurn>;
    review: (ref: ScopedThreadRef) => void;
  },
) {
  const { loadArchiveFamily } = ports;
  if (
    appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId)?.environment
      .capabilities.threadArchiveFamiliesV2 !== true
  ) {
    Dialog.alert("Server update required", THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE);
    return null;
  }
  const shells = appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
  const observedFailure =
    thread.archivePending?.status === "failed" ? thread.archivePending : undefined;
  thread =
    shells.find(
      (candidate) => candidate.id === thread.id && candidate.environmentId === thread.environmentId,
    ) ?? thread;
  const failedAttempt =
    observedFailure ??
    (thread.archivePending?.status === "failed" ? thread.archivePending : undefined);
  const archiveThreadId = failedAttempt?.threadId ?? thread.id;
  const familyResult = await loadArchiveFamily({
    environmentId: thread.environmentId,
    input: { threadId: archiveThreadId },
  });
  if (familyResult._tag === "Failure") {
    const error = Cause.squash(familyResult.cause);
    Dialog.alert(
      "Could not archive thread",
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "The thread could not be archived.",
    );
    return null;
  }
  const owner = familyResult.value.threads.find(
    (candidate) =>
      candidate.id === archiveThreadId && candidate.environmentId === thread.environmentId,
  );
  if (!owner) {
    Dialog.alert(
      "Could not archive thread",
      "The archive owner is no longer available. Refresh the thread list before retrying.",
    );
    return null;
  }
  thread = owner;
  if (thread.persistent === true) {
    Dialog.alert(
      "Could not archive thread",
      "This thread is persistent. Remove its persistent protection before archiving it.",
    );
    return null;
  }

  const family = resolveThreadArchiveFamily(familyResult.value);
  const childDisposition = family.requiresConfirmation
    ? await new Promise<ThreadArchiveChildDisposition | null>((resolve) => {
        const reviewFamily = () => {
          resolve(null);
          ports.review({ environmentId: thread.environmentId, threadId: thread.id });
        };
        const showOwner = (target: ThreadArchiveConsultationTarget, feedback?: string) => {
          const reason = threadArchiveConsultationUnavailableReason(target);
          const details = target.work
            .map((work) =>
              [
                family.threads.find((item) => item.id === work.threadId)?.title ||
                  "Untitled thread",
                work.threadId,
                work.taskId,
                work.runId,
                work.attemptId,
              ]
                .filter(Boolean)
                .join(" · "),
            )
            .join("\n");
          Dialog.alert(
            target.ownerTitle,
            [details, reason, feedback].filter(Boolean).join("\n\n"),
            [
              { text: "Back", style: "cancel", onPress: () => showFamily() },
              {
                text: "Review agent",
                onPress: () => {
                  resolve(null);
                  ports.review({
                    environmentId: thread.environmentId,
                    threadId: target.ownerThreadId,
                  });
                },
              },
              ...(!reason
                ? [
                    {
                      text: "Ask the agent",
                      onPress: () => {
                        void consultThreadArchiveAgent({
                          familyRef: { environmentId: thread.environmentId, threadId: thread.id },
                          ownerThreadId: target.ownerThreadId,
                          inspect: async () => {
                            const result = await loadArchiveFamily({
                              environmentId: thread.environmentId,
                              input: { threadId: thread.id },
                            });
                            if (result._tag === "Failure") throw Cause.squash(result.cause);
                            return result.value;
                          },
                          readOwner: (ref) =>
                            appAtomRegistry
                              .get(environmentThreadShells.threadShellsAtom)
                              .find(
                                (item) =>
                                  item.id === ref.threadId &&
                                  item.environmentId === ref.environmentId,
                              ) ?? null,
                          randomId: uuidv4,
                          send: async (input) => {
                            const result = await ports.sendArchiveQuestion(input);
                            if (result._tag === "Failure") throw Cause.squash(result.cause);
                          },
                        })
                          .then((failure) => {
                            if (failure) showOwner(target, failure);
                            else {
                              resolve(null);
                              ports.review({
                                environmentId: thread.environmentId,
                                threadId: target.ownerThreadId,
                              });
                            }
                          })
                          .catch((error) => {
                            showOwner(
                              target,
                              error instanceof Error
                                ? error.message
                                : "The question could not be sent. Try again.",
                            );
                          });
                      },
                    },
                  ]
                : []),
            ],
            { cancelable: true, onDismiss: () => resolve(null) },
          );
        };
        const review = () => {
          const targets = family.consultationTargets ?? [];
          if (!targets.length) {
            reviewFamily();
            return;
          }
          // A native alert has three buttons on Android. Choose one owner per step; never fan out.
          const selectOwner = (index: number) => {
            const target = targets[index];
            if (!target) {
              reviewFamily();
              return;
            }
            Dialog.alert(
              "Review before archiving",
              target.ownerTitle,
              [
                { text: "Review family", onPress: reviewFamily },
                { text: "Review agent work", onPress: () => showOwner(target) },
                {
                  text: index + 1 < targets.length ? "Next agent" : "Back",
                  style: "cancel",
                  onPress: () =>
                    index + 1 < targets.length ? selectOwner(index + 1) : showFamily(),
                },
              ],
              { cancelable: true, onDismiss: () => resolve(null) },
            );
          };
          selectOwner(0);
        };
        const showFamily = () =>
          Dialog.alert(
            `Archive "${thread.title || "Untitled thread"}"?`,
            family.message,
            [
              {
                text: family.blocked ? "Close" : "Cancel",
                style: "cancel",
                onPress: () => resolve(null),
              },
              { text: "Review", onPress: review },
              ...(!family.blocked
                ? [
                    {
                      text: family.confirmLabel,
                      style: "destructive" as const,
                      onPress: () => resolve(family.disposition),
                    },
                  ]
                : []),
            ],
            { cancelable: true, onDismiss: () => resolve(null) },
          );
        showFamily();
      })
    : "archive_if_idle";
  if (childDisposition === null) return null;
  return {
    owner: thread,
    participantIds: [thread.id, ...family.childThreadIds],
    input: {
      threadId: thread.id,
      ...(failedAttempt === undefined ? {} : { expectedArchiveCommandId: failedAttempt.commandId }),
      childDisposition,
      expectedChildThreadIds: family.childThreadIds,
    },
  };
}
