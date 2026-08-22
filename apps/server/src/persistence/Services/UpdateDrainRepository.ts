import type { CommandId, UpdateDrainCommandReceipt, UpdateDrainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { UpdateDrainRepositoryError } from "../Errors.ts";

export interface UpdateDrainRepositoryShape {
  readonly readAllEvents: () => Effect.Effect<
    ReadonlyArray<UpdateDrainEvent>,
    UpdateDrainRepositoryError
  >;
  readonly getReceipt: (
    commandId: CommandId,
  ) => Effect.Effect<Option.Option<UpdateDrainCommandReceipt>, UpdateDrainRepositoryError>;
  readonly commitAccepted: (input: {
    readonly event: Omit<UpdateDrainEvent, "sequence">;
    readonly receipt: Omit<UpdateDrainCommandReceipt, "resultSequence">;
  }) => Effect.Effect<
    { readonly event: UpdateDrainEvent; readonly receipt: UpdateDrainCommandReceipt },
    UpdateDrainRepositoryError
  >;
  readonly saveRejected: (
    receipt: UpdateDrainCommandReceipt,
  ) => Effect.Effect<void, UpdateDrainRepositoryError>;
}

export class UpdateDrainRepository extends Context.Service<
  UpdateDrainRepository,
  UpdateDrainRepositoryShape
>()("t3/persistence/Services/UpdateDrainRepository") {}
