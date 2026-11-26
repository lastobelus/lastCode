import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function reportThreadOperationFailure(
  result: AtomCommandResult<unknown, unknown>,
  title: string,
) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: m(title),
      description: error instanceof Error ? error.message : m(msg("An error occurred.")),
    }),
  );
}
