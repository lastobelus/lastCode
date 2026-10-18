import * as Layer from "effect/Layer";

import * as UpdateDrainAdmission from "./UpdateDrainAdmission.ts";

/** Admission stays open in tests that exercise orchestration rather than update draining. */
export const layerOpen = Layer.mock(UpdateDrainAdmission.UpdateDrainAdmission)({
  admit: (_kind, effect) => effect,
  admitOrElse: (_kind, effect) => effect,
});
