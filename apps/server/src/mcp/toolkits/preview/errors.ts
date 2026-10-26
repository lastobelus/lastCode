import {
  PreviewAutomationAvailabilityReason,
  PreviewAutomationConnectionId,
  PreviewAutomationOperation,
  type PreviewAutomationError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PreviewRemoteUnavailableFailure = Schema.Struct({
  _tag: Schema.Literal("PreviewAutomationRemoteUnavailableError"),
  message: Schema.String,
  operation: PreviewAutomationOperation,
  connectionId: PreviewAutomationConnectionId,
  requestId: Schema.String,
  reason: Schema.optional(PreviewAutomationAvailabilityReason),
});

export const previewToolFailure = (error: PreviewAutomationError) => {
  if (error._tag !== "PreviewAutomationRemoteUnavailableError") return error;
  // MCP flattens Error instances to their message. Use a declared plain failure
  // to retain correlation; never serialize the private remote cause or host id.
  return {
    _tag: error._tag,
    message: `Preview automation ${error.operation} is unavailable.`,
    operation: error.operation,
    connectionId: error.connectionId,
    requestId: error.requestId,
    ...(error.reason === undefined ? {} : { reason: error.reason }),
  };
};
