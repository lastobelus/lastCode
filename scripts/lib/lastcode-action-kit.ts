// @effect-diagnostics nodeBuiltinImport:off -- Dependency-free Action reporting for host scripts.
import * as NodeBuffer from "node:buffer";

import type { ActionProgress, ActionReport } from "@t3tools/contracts";

// Mirrors `@t3tools/shared/actionResumeProtocol`; the kit's test decodes these frames with it.
const ACTION_PROTOCOL_VERSION = 1;
const ACTION_PROTOCOL_OSC = "777;T3ActionEvent";
const ACTION_RUN_ID_ENV = "T3CODE_ACTION_RUN_ID";
const ACTION_EVENT_TOKEN_ENV = "T3CODE_ACTION_EVENT_TOKEN";
const ACTION_EVENT_MAX_ENCODED_CHARS = 16_384;

type ActionEvent =
  | { readonly kind: "progress"; readonly progress: ActionProgress }
  | { readonly kind: "result"; readonly report: ActionReport };

type ReporterOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write: (data: string) => void;
  readonly log?: (message: string) => void;
};

/**
 * Encodes an Action protocol frame without loading application dependencies, so LastCode Actions
 * still start while the checkout's `node_modules` is being reinstalled underneath them (#290).
 * The host validates every frame when it decodes it.
 */
export function lastCodeActionFrame(input: {
  readonly runId: string;
  readonly token: string;
  readonly event: ActionEvent;
}): string {
  const payload = NodeBuffer.Buffer.from(JSON.stringify(input.event)).toString("base64url");
  if (payload.length > ACTION_EVENT_MAX_ENCODED_CHARS) {
    throw new Error("Action protocol event exceeds the encoded transport limit.");
  }
  return `\u001b]${ACTION_PROTOCOL_OSC};${input.runId};${input.token};${payload}\u0007`;
}

/**
 * Structured reporting for LastCode's repository-owned resumable Project Actions.
 * Outside a resumable run, reports remain readable ordinary terminal output.
 */
export function createLastCodeActionReporter(options: ReporterOptions) {
  const runId = options.env[ACTION_RUN_ID_ENV];
  const token = options.env[ACTION_EVENT_TOKEN_ENV];
  let terminalResultEmitted = false;

  const emit = (event: ActionEvent) => {
    if (runId && token) {
      options.write(lastCodeActionFrame({ runId, token, event }));
      return;
    }
    options.log?.(
      `[lastcode-action] ${event.kind === "progress" ? "Progress" : "Result"}: ${JSON.stringify(event.kind === "progress" ? event.progress : event.report)}`,
    );
  };

  return {
    progress(progress: Omit<ActionProgress, "version">): void {
      emit({ kind: "progress", progress: { version: ACTION_PROTOCOL_VERSION, ...progress } });
    },
    result(report: Omit<ActionReport, "version">): void {
      if (terminalResultEmitted) {
        throw new Error("LastCode Actions may emit only one terminal result.");
      }
      terminalResultEmitted = true;
      emit({ kind: "result", report: { version: ACTION_PROTOCOL_VERSION, ...report } });
    },
  };
}

export const lastCodeAction = createLastCodeActionReporter({
  env: process.env,
  write: (data) => process.stdout.write(data),
  log: (message) => process.stdout.write(`${message}\n`),
});
