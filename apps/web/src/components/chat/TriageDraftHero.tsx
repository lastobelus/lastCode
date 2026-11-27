import {
  LASTCODE_TRIAGE_CLI_COMMAND as TRIAGE_CLI_COMMAND,
  LASTCODE_TRIAGE_CUSTOM_HOME_HINT,
} from "@t3tools/shared/desktopDistribution";
import { msg, T, Var } from "gt-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import { InlineButton } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/**
 * The empty-draft hero for a triage session, in place of "What should we work on?".
 * Keeps the regular hero's heading-plus-one-line rhythm above the composer.
 */
export function TriageDraftHero(props: {
  readonly machineLabel: string | null;
  readonly serverVersion: string | null;
  readonly cliCommand: string | null;
}) {
  const cliCommand = props.cliCommand ?? TRIAGE_CLI_COMMAND;
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1500,
    target: {
      target: "command",
      unavailableMessage: msg("Clipboard API is unavailable while copying command."),
      failureMessage: msg("Failed to copy command to the clipboard."),
    },
  });
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        <T>What went wrong?</T>
      </h1>
      <p className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 text-sm">
        <SharedTooltipTrigger
          render={<span tabIndex={0} className="min-w-0 truncate font-medium text-foreground" />}
          label={
            <>
              <T>
                The agent reads LastCode's logs and source here, and asks before it applies a fix or
                posts anything.
              </T>
            </>
          }
          side="bottom"
        >
          {props.machineLabel ?? <T>This machine</T>}
          {props.serverVersion === null ? null : (
            <span className="ml-1.5 font-normal text-muted-foreground">v{props.serverVersion}</span>
          )}
        </SharedTooltipTrigger>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <SharedTooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto min-w-0"
              onClick={() => copyToClipboard(cliCommand, undefined)}
            />
          }
          label={
            <>
              <T>Copy command, for a terminal</T>
              {props.cliCommand === null ? ` ${LASTCODE_TRIAGE_CUSTOM_HOME_HINT}` : ""}
            </>
          }
          side="bottom"
        >
          {isCopied ? (
            <T>Copied</T>
          ) : (
            <T>
              or run
              <code className="ml-1 min-w-0 truncate font-mono text-xs">
                <Var>{cliCommand}</Var>
              </code>
            </T>
          )}
        </SharedTooltipTrigger>
      </p>
    </div>
  );
}
