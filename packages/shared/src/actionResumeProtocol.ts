import { ActionProtocolEvent, type ActionProgress, type ActionReport } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const ACTION_PROTOCOL_VERSION = 1;
const ACTION_PROTOCOL_OSC = "777;T3ActionEvent";
export const ACTION_RUN_ID_ENV = "T3CODE_ACTION_RUN_ID";
export const ACTION_EVENT_TOKEN_ENV = "T3CODE_ACTION_EVENT_TOKEN";

const ACTION_EVENT_MAX_ENCODED_CHARS = 16_384;
const decodeActionProtocolEventJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ActionProtocolEvent),
);
const validateActionProtocolEvent = Schema.decodeUnknownSync(ActionProtocolEvent);

export interface ActionProtocolDecoder {
  readonly push: (data: string) => {
    readonly output: string;
    readonly events: ReadonlyArray<ActionProtocolEvent>;
    readonly invalidFrames: number;
  };
  readonly finish: () => string;
}

export function actionProtocolFrame(input: {
  readonly runId: string;
  readonly token: string;
  readonly event: ActionProtocolEvent;
}): string {
  const event = validateActionProtocolEvent(input.event);
  const payload = Encoding.encodeBase64Url(JSON.stringify(event));
  if (payload.length > ACTION_EVENT_MAX_ENCODED_CHARS) {
    throw new Error("Action protocol event exceeds the encoded transport limit.");
  }
  return `\u001b]${ACTION_PROTOCOL_OSC};${input.runId};${input.token};${payload}\u0007`;
}

function decodeActionProtocolPayload(payload: string): ActionProtocolEvent | null {
  if (payload.length === 0 || payload.length > ACTION_EVENT_MAX_ENCODED_CHARS) return null;
  const decoded = Encoding.decodeBase64UrlString(payload);
  if (!Result.isSuccess(decoded)) return null;
  return Option.getOrNull(decodeActionProtocolEventJson(decoded.success));
}

export function createActionProtocolDecoder(input: {
  readonly runId: string;
  readonly token: string;
}): ActionProtocolDecoder {
  const prefix = `\u001b]${ACTION_PROTOCOL_OSC};${input.runId};${input.token};`;
  let pending = "";

  const push: ActionProtocolDecoder["push"] = (data) => {
    pending += data;
    let output = "";
    const events: ActionProtocolEvent[] = [];
    let invalidFrames = 0;

    while (pending.length > 0) {
      const startIndex = pending.indexOf(prefix);
      if (startIndex === -1) {
        const safeLength = Math.max(0, pending.length - (prefix.length - 1));
        output += pending.slice(0, safeLength);
        pending = pending.slice(safeLength);
        break;
      }

      output += pending.slice(0, startIndex);
      const payloadStart = startIndex + prefix.length;
      const endIndex = pending.indexOf("\u0007", payloadStart);
      if (endIndex === -1) {
        if (pending.length - payloadStart <= ACTION_EVENT_MAX_ENCODED_CHARS) {
          pending = pending.slice(startIndex);
          break;
        }
        invalidFrames += 1;
        pending = pending.slice(payloadStart);
        continue;
      }

      const event = decodeActionProtocolPayload(pending.slice(payloadStart, endIndex));
      if (event === null) invalidFrames += 1;
      else events.push(event);
      pending = pending.slice(endIndex + 1);
    }

    return { output, events, invalidFrames };
  };

  return {
    push,
    finish: () => {
      const output = pending;
      pending = "";
      return output;
    },
  };
}

type ReporterEnvironment = Readonly<Record<string, string | undefined>>;

export function createActionReporter(input: {
  readonly env: ReporterEnvironment;
  readonly write: (data: string) => void;
  readonly log?: (message: string) => void;
}) {
  const runId = input.env[ACTION_RUN_ID_ENV];
  const token = input.env[ACTION_EVENT_TOKEN_ENV];

  const emit = (event: ActionProtocolEvent) => {
    if (runId && token) {
      input.write(actionProtocolFrame({ runId, token, event }));
      return;
    }
    input.log?.(
      `[lastcode-action] ${event.kind === "progress" ? "Progress" : "Result"}: ${JSON.stringify(event.kind === "progress" ? event.progress : event.report)}`,
    );
  };

  return {
    progress(progress: Omit<ActionProgress, "version">): void {
      emit({ kind: "progress", progress: { version: ACTION_PROTOCOL_VERSION, ...progress } });
    },
    result(report: Omit<ActionReport, "version">): void {
      emit({ kind: "result", report: { version: ACTION_PROTOCOL_VERSION, ...report } });
    },
  };
}
