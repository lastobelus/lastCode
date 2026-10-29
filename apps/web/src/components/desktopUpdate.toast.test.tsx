import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";

type ClickableElement = ReactElement<{ readonly onClick?: () => void }>;

function findReleaseNotesLink(node: ReactNode): ClickableElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findReleaseNotesLink(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  if (element.type === "button") return element as ClickableElement;
  if (typeof element.type === "function") {
    const render = element.type as (props: unknown) => ReactNode;
    return findReleaseNotesLink(render(element.props));
  }
  return findReleaseNotesLink(element.props.children);
}

function getDescription(): ReactNode {
  const toast = testState.addToast.mock.calls[0]?.[0] as { description?: ReactNode } | undefined;
  return toast?.description ?? null;
}

function downloadedState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    source: "hosted",
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.0.29",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.0.30",
    downloadedVersion: "0.0.30",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: 100,
    localBuildProgress: null,
    localBuildFailure: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

it("reports a local build without linking to an upstream GitHub release", () => {
  showDesktopUpdateDownloadedToast(
    { openExternal: vi.fn() },
    downloadedState({ source: "lastcode-local" }),
  );

  expect(findReleaseNotesLink(getDescription())).toBeNull();
  expect(testState.addToast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Local nightly built" }),
  );
});
