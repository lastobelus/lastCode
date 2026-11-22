import {
  CommandId,
  LinkedArchiveOperation,
  LinkedArchiveSelection,
  OrchestrationV2ThreadArchiveFamily,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

const ArchiveToolSelection = Schema.Array(LinkedArchiveSelection);

// The preview returns copyable choices. The compact MCP input still decodes every cohort.
export const ArchiveToolSelectionInput = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(ArchiveToolSelection),
);

const retryFields = {
  threadId: ThreadId,
  action: Schema.Literals(["archive", "unarchive"]),
  expectedLinkedArchiveCommandId: CommandId,
  linkedArchiveSelection: Schema.optional(ArchiveToolSelection),
};

export const ArchiveToolOperation = LinkedArchiveOperation.mapFields((fields) => ({
  ...fields,
  retryArgs: Schema.optional(Schema.Struct(retryFields)),
  retryArgsAfterStopConsent: Schema.optional(
    Schema.Struct({ ...retryFields, childDisposition: Schema.Literal("stop_and_archive") }),
  ),
}));

export const ArchiveFamilyToolResult = OrchestrationV2ThreadArchiveFamily.mapFields((fields) => ({
  ...Struct.omit(fields, ["threads", "canPromote", "promotableChildThreadIds"]),
  linkedArchiveSelection: Schema.optional(ArchiveToolSelection),
  linkedArchiveOperations: Schema.optional(Schema.Array(ArchiveToolOperation)),
  linkedArchiveGuidance: Schema.optional(Schema.String),
}));
