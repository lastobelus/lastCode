import type { AtomCommand, AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  archivePreviewSelection,
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
import { msg } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
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
    Dialog.alert(m(msg("Server update required")), m(THREAD_ARCHIVE_UPDATE_REQUIRED_MESSAGE));
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
      m(msg("Could not archive thread")),
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : m(msg("The thread could not be archived.")),
    );
    return null;
  }
  const owner = familyResult.value.threads.find(
    (candidate) =>
      candidate.id === archiveThreadId && candidate.environmentId === thread.environmentId,
  );
  if (!owner) {
    Dialog.alert(
      m(msg("Could not archive thread")),
      m(msg("The archive owner is no longer available. Refresh the thread list before retrying.")),
    );
    return null;
  }
  thread = owner;
  if (thread.persistent === true) {
    Dialog.alert(
      m(msg("Could not archive thread")),
      m(msg("This thread is persistent. Remove its persistent protection before archiving it.")),
    );
    return null;
  }

  const family = familyResult.value;
  const choice = family.requiresConfirmation
    ? await new Promise<{
        childDisposition: ThreadArchiveChildDisposition;
        includeTypedIn?: boolean;
      } | null>((resolve) => {
        const reviewFamily = () => {
          resolve(null);
          ports.review({ environmentId: thread.environmentId, threadId: thread.id });
        };
        const showOwner = (target: ThreadArchiveConsultationTarget, feedback?: string) => {
          const reason = threadArchiveConsultationUnavailableReason(target, m);
          const details = target.work
            .map((work) =>
              [
                family.threads.find((item) => item.id === work.threadId)?.title ||
                  m(msg("Untitled thread")),
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
              {
                text: m(msg("Back", { $context: "button, return to the previous archive dialog" })),
                style: "cancel",
                onPress: () => showFamily(),
              },
              {
                text: m(msg("Review agent")),
                onPress: () => {
                  resolve(null);
                  ports.review({
                    environmentId: thread.environmentId,
                    threadId: target.ownerThreadId,
                  });
                },
              },
              ...(reason === null
                ? [
                    {
                      text: m(msg("Ask the agent")),
                      onPress: () => {
                        void consultThreadArchiveAgent(
                          {
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
                          },
                          m,
                        )
                          .then((failure) => {
                            if (failure !== null) showOwner(target, failure);
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
                                : m(msg("The question could not be sent. Try again.")),
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
              m(msg("Review before archiving")),
              target.ownerTitle,
              [
                { text: m(msg("Review family")), onPress: reviewFamily },
                { text: m(msg("Review agent work")), onPress: () => showOwner(target) },
                {
                  text:
                    index + 1 < targets.length
                      ? m(msg("Next agent"))
                      : m(
                          msg("Back", {
                            $context: "button, return to the previous archive dialog",
                          }),
                        ),
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
        const showFamily = (includeTypedIn = false) => {
          const confirmation = resolveThreadArchiveFamily(
            family,
            m,
            includeTypedIn,
            (candidate) =>
              appAtomRegistry.get(
                environmentProjects.projectAtom(
                  scopeProjectRef(candidate.environmentId, candidate.projectId),
                ),
              )?.title ?? candidate.projectId,
          );
          Dialog.alert(
            m(msg('Archive "{title}"?', { title: thread.title || m(msg("Untitled thread")) })),
            confirmation.message,
            [
              {
                text: confirmation.blocked
                  ? m(msg("Close", { $context: "verb, dismiss a dialog" }))
                  : m(msg("Cancel")),
                style: "cancel",
                onPress: () => resolve(null),
              },
              confirmation.canIncludeTypedIn
                ? {
                    text: includeTypedIn
                      ? m(msg("Keep threads you’ve written in open"))
                      : m(msg("Also archive threads you’ve written in")),
                    onPress: () => showFamily(!includeTypedIn),
                  }
                : {
                    text: m(msg("Review", { $context: "verb, inspect a thread before archiving" })),
                    onPress: review,
                  },
              ...(!confirmation.blocked
                ? [
                    {
                      text: confirmation.confirmLabel,
                      style: "destructive" as const,
                      onPress: () =>
                        resolve({ childDisposition: confirmation.disposition, includeTypedIn }),
                    },
                  ]
                : []),
            ],
            { cancelable: true, onDismiss: () => resolve(null) },
          );
        };
        showFamily();
      })
    : { childDisposition: "archive_if_idle" as const };
  if (choice === null) return null;
  const selection = archivePreviewSelection(family, choice.includeTypedIn);
  return {
    owner: thread,
    participantIds: selection.expectedArchiveThreadIds ?? [thread.id, ...family.childThreadIds],
    input: {
      threadId: thread.id,
      ...(failedAttempt === undefined ? {} : { expectedArchiveCommandId: failedAttempt.commandId }),
      childDisposition: choice.childDisposition,
      expectedChildThreadIds: family.childThreadIds,
      ...selection,
    },
  };
}
