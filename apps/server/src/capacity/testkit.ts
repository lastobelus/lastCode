import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Capacity } from "./Capacity.ts";
import { unknownCapacitySnapshot } from "./logic.ts";

export const snapshot = unknownCapacitySnapshot(0);
export const layer = Layer.succeed(Capacity, { read: Effect.succeed(snapshot) });
