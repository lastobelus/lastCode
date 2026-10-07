import {
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";

/**
 * An explicit `open`/`show` is the agent deliberately surfacing or suppressing
 * its work, so it outranks the preference; the setting only decides what
 * happens when the agent said nothing either way.
 */
export function shouldOpenPreviewMiniPlayer(
  input: PreviewAutomationOpenInput,
  autoShowFloatingPreview = true,
): boolean {
  return input.open ?? input.show ?? autoShowFloatingPreview;
}

export function shouldAutoShowPreviewForAutomationUse(input: {
  readonly operation: PreviewAutomationOperation;
  readonly autoShowFloatingPreview: boolean;
  readonly presentationSuppressed: boolean;
}): boolean {
  return (
    input.operation !== "open" &&
    input.operation !== "openWithProfile" &&
    input.operation !== "profiles" &&
    input.autoShowFloatingPreview &&
    !input.presentationSuppressed
  );
}

export function explicitlySuppressesPreviewMiniPlayer(input: PreviewAutomationOpenInput): boolean {
  return (input.open ?? input.show) === false;
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}
