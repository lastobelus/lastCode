import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, TRIAGE_PROMPT_FILE_NAME } from "@t3tools/contracts";
import {
  LASTCODE_TRIAGE_CLI_COMMAND as TRIAGE_CLI_COMMAND,
  LASTCODE_TRIAGE_CUSTOM_HOME_HINT,
} from "@t3tools/shared/desktopDistribution";
import { useRouter } from "@tanstack/react-router";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { currentClientMetadata } from "~/connection/platform";
import { readEnvironment } from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { writeTextToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";

const copyTriageCliCommand = (command: string) =>
  writeTextToClipboard(command, "command").catch(() =>
    toastManager.add({
      type: "error",
      title: `Could not copy. Type ${command} instead.`,
    }),
  );

/** A draft is a triage draft while its message still links the playbook file. */
export const isTriagePrompt = (prompt: string) => prompt.includes(`[${TRIAGE_PROMPT_FILE_NAME}](`);

/**
 * In-app `t3 triage`: the server writes the session files and starts cloning
 * the matching source, then a No project draft opens with the playbook linked.
 * The draft hero explains the rest; the user picks a provider and describes
 * the problem.
 */
export function useStartTriage() {
  const router = useRouter();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const prepare = useAtomCommand(serverEnvironment.prepareTriage, { reportFailure: false });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });

  // With no draft to show, a toast is the only place to point at the CLI.
  const fail = (description: string, environmentId: EnvironmentId) => {
    const command =
      readEnvironment(environmentId)?.serverConfig?.triageCliCommand ?? TRIAGE_CLI_COMMAND;
    const hint = command === TRIAGE_CLI_COMMAND ? ` ${LASTCODE_TRIAGE_CUSTOM_HOME_HINT}` : "";
    const details = `${description} Run ${command} in a terminal on that machine instead.${hint}`;
    return toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not start triage",
        description: details,
        timeout: 0,
        actionProps: {
          children: "Copy command",
          onClick: () => void copyTriageCliCommand(command),
        },
        // "Copy command" is the copy that helps here, not the error text.
        data: { hideCopyButton: true, expandableContent: details },
      }),
    );
  };
  const failWith = (
    result: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    environmentId: EnvironmentId,
  ) => {
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    fail(error instanceof Error ? error.message : "An error occurred.", environmentId);
  };

  // `routeChanged` tells the steps the user went elsewhere while they waited;
  // the draft then stays closed instead of pulling them away.
  const openTriageDraft = async (environmentId: EnvironmentId, routeChanged: () => boolean) => {
    const prepared = await prepare({
      environmentId,
      input: { client: currentClientMetadata() },
    });
    if (prepared._tag === "Failure") return failWith(prepared, environmentId);
    const project = await openScratch({ environmentId, input: {} });
    if (project._tag === "Failure") return failWith(project, environmentId);
    if (routeChanged()) return;
    // A null result means the user went elsewhere; only a throw is a failure.
    await handleNewThread(scopeProjectRef(project.value.environmentId, project.value.id), {
      prompt: prepared.value.prompt,
    }).catch(() => fail("LastCode could not open a new thread.", environmentId));
  };

  return async (environmentId: EnvironmentId) => {
    if (scratchWorkspaceRootFor(environmentId) === null) {
      fail("This machine cannot start threads without a project.", environmentId);
      return;
    }
    const requestingRouteHref = router.state.location.href;
    // The palette is already closed, and a slow network can hold up the source
    // lookup, so say something when the draft does not open at once.
    let pendingToastId: ReturnType<typeof toastManager.add> | undefined;
    const pendingTimer = setTimeout(() => {
      pendingToastId = toastManager.add({
        type: "loading",
        title: "Starting triage…",
        timeout: 0,
      });
    }, 400);
    await openTriageDraft(
      environmentId,
      () => router.state.location.href !== requestingRouteHref,
    ).finally(() => {
      clearTimeout(pendingTimer);
      if (pendingToastId !== undefined) toastManager.close(pendingToastId);
    });
  };
}
