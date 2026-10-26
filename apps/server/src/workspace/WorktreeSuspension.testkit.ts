import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorktreeSuspension } from "./WorktreeSuspension.ts";
import { WorktreeSuspensionRegistry } from "./WorktreeSuspensionRegistry.ts";

export const layerWith = (
  automaticProtection: WorktreeSuspensionRegistry["Service"]["automaticProtection"],
  sweep: WorktreeSuspension["Service"]["sweep"] = Effect.void,
) =>
  Layer.merge(
    Layer.mock(WorktreeSuspension)({ sweep }),
    Layer.mock(WorktreeSuspensionRegistry)({
      root: "/test/saved-workspaces",
      list: Effect.succeed([]),
      automaticProtection,
    }),
  );

export const layer = layerWith(() => Effect.succeed(null));
