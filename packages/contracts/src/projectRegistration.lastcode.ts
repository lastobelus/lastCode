import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

export const ThreadOwner = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });
export type ThreadOwner = typeof ThreadOwner.Type;

/** Trusted registration metadata, persisted with the project's creation event. */
export const ProjectRegistration = Schema.Struct({
  owner: ThreadOwner,
  temporary: Schema.optional(Schema.Literal(true)),
});
export type ProjectRegistration = typeof ProjectRegistration.Type;

export const projectRegistrationViewFields = {
  owner: Schema.optional(ThreadOwner),
  temporary: Schema.optional(Schema.Boolean),
};
