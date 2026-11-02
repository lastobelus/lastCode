import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WorktreeSuspensionRegistry } from "./WorktreeSuspensionRegistry.ts";

export const layer = Layer.mock(WorktreeSuspensionRegistry)({
  root: "/test/saved-workspaces",
  list: Effect.succeed([]),
  automaticProtection: () => Effect.succeed(null),
});
