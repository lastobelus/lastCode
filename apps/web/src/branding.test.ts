import { expect, it } from "vite-plus/test";
import { resolveServerBackedAppStageLabel } from "./branding.logic";

it("recognizes rebuilt nightly primary server versions", () => {
  expect(
    resolveServerBackedAppStageLabel({
      primaryServerVersion: "0.0.28-nightly.20260616.12.1",
      fallbackStageLabel: "Alpha",
    }),
  ).toBe("Nightly");
});
