import * as Schema from "effect/Schema";
import { CommandId, ThreadId } from "./baseSchemas.ts";

export const ThreadOwnershipAction = Schema.Literals(["promote", "return_to_owner"]);
export type ThreadOwnershipAction = typeof ThreadOwnershipAction.Type;

export const ThreadOwnershipChange = Schema.Struct({
  type: Schema.Literal("thread.ownership.change"),
  commandId: CommandId,
  threadId: ThreadId,
  action: ThreadOwnershipAction,
});

export const ThreadOwnershipAvailability = Schema.NullOr(
  Schema.Struct({
    action: ThreadOwnershipAction,
    ownerHere: Schema.Boolean,
    refusal: Schema.NullOr(Schema.Literals(["in_flight", "owner_unavailable", "unavailable"])),
  }),
);
export type ThreadOwnershipAvailability = typeof ThreadOwnershipAvailability.Type;
