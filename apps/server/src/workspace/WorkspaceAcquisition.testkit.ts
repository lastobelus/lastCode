import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WorkspaceAcquisition } from "./WorkspaceAcquisition.ts";

export const layerWith = (acquire: WorkspaceAcquisition["Service"]["acquire"]) =>
  Layer.succeed(WorkspaceAcquisition, {
    acquire,
    install: () => Effect.die("Test workspace handlers are fixed by their fixture."),
  });

export const layer = layerWith((input) =>
  Effect.succeed({ path: input.path, branch: null, restored: false }),
);
