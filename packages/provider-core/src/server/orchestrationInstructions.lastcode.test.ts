import { assert, it } from "@effect/vitest";

import { t3OrchestrationPrompt } from "./orchestrationInstructions.ts";

it("refreshes the Action instruction in a resumed conversation without repeating general guidance", () => {
  const prompt = "Run the checks.";
  const resumed = (disabled: boolean, alreadyDelivered: boolean) =>
    t3OrchestrationPrompt({
      prompt,
      hasT3Mcp: true,
      hasDeviceTools: false,
      orchestrationDelivered: true,
      deviceInstructionsDelivered: false,
      projectActionLaunchDisabled: disabled,
      projectActionLaunchInstructionsDelivered: alreadyDelivered,
    });
  assert.include(resumed(true, false), "./scripts/lc-run");
  assert.include(resumed(false, false), "opted-in Actions");
  assert.notInclude(resumed(true, false), "## T3 Code orchestration");
  assert.notInclude(resumed(false, false), "## T3 Code orchestration");
  assert.equal(resumed(true, true), prompt);
  assert.equal(resumed(false, true), prompt);
});
