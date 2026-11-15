import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import {
  hostRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { readThreadPreviewState } from "../previewStateStore";
import { useRightPanelSurfaceClose } from "./useRightPanelSurfaceClose";

const fixture = vi.hoisted(() => ({
  allowed: new Set<string>(),
  close: vi.fn(),
  rememberClose: vi.fn(),
  activate: vi.fn(),
  snapshots: new Map<string, PreviewSessionSnapshot>(),
}));
vi.mock("../previewStateStore", () => ({
  readThreadPreviewState: vi.fn((ref: ScopedThreadRef) => {
    const snapshot = fixture.snapshots.get(ref.environmentId);
    return { sessions: snapshot ? { [snapshot.tabId]: snapshot } : {}, desktopByTabId: {} };
  }),
  setActivePreviewTab: (...args: unknown[]) => fixture.activate(...args),
}));
vi.mock("../components/preview/closePreviewSession", () => ({
  closePreviewSession: (input: unknown) => fixture.rememberClose(input),
}));
vi.mock("../components/terminal/useThreadTerminalActions", () => ({
  useThreadTerminalActions: () => ({}),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => fixture.close }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (id: string) => fixture.allowed.has(id),
}));
vi.mock("../state/preview", () => ({ previewEnvironment: { close: {} } }));
vi.mock("../state/threads", () => ({ threadEnvironment: { delete: {} } }));
vi.mock("../state/entities", () => ({ readThreadShell: () => null }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: () => null } }));
vi.mock("../lib/terminalFocus", () => ({ focusPanelTerminalAfterClose: () => {} }));

it.each([true, false])(
  "closes a hosted browser in its source environment when authorized=%s",
  (allowed) => {
    fixture.rememberClose.mockClear();
    fixture.activate.mockClear();
    const host = scopeThreadRef(EnvironmentId.make("parent-environment"), ThreadId.make("parent"));
    const child = scopeThreadRef(EnvironmentId.make("child-environment"), ThreadId.make("child"));
    const childSnapshot: PreviewSessionSnapshot = {
      threadId: child.threadId,
      tabId: "shared-tab",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    fixture.snapshots = new Map([
      [child.environmentId, childSnapshot],
      [host.environmentId, { ...childSnapshot, threadId: host.threadId }],
    ]);
    fixture.allowed = new Set(allowed ? [child.environmentId] : [host.environmentId]);
    useRightPanelStore.setState({ byThreadKey: {} });
    const store = useRightPanelStore.getState();
    const unhost = hostRightPanel(child, host);
    try {
      store.openBrowser(host, "shared-tab");
      store.openBrowser(child, "shared-tab", true);
      const surface = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, host)
        .surfaces[1]!;
      const captureActions =
        vi.fn<(actions: ReturnType<typeof useRightPanelSurfaceClose>) => void>();
      function Harness({ threadRef }: { threadRef: ScopedThreadRef }) {
        captureActions(useRightPanelSurfaceClose({ threadRef, terminalLabelsById: new Map() }));
        return null;
      }
      renderToStaticMarkup(<Harness threadRef={host} />);
      captureActions.mock.lastCall![0].closeSurface(surface);
      expect(fixture.rememberClose).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed)
        expect(fixture.rememberClose).toHaveBeenCalledWith({
          closePreview: fixture.close,
          snapshot: childSnapshot,
          tabId: "shared-tab",
          threadRef: child,
        });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, host).surfaces,
      ).toEqual([{ id: "browser:shared-tab", kind: "preview", resourceId: "shared-tab" }]);
      expect(fixture.activate).toHaveBeenCalledWith(host, "shared-tab");

      store.openBrowser(child, "shared-tab", true);
      store.open(host, "files");
      renderToStaticMarkup(<Harness threadRef={host} />);
      captureActions.mock.lastCall![0].closeSurface(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, host).surfaces[2]!,
      );
      expect(fixture.activate).toHaveBeenLastCalledWith(child, "shared-tab");
      expect(vi.mocked(readThreadPreviewState)).toHaveBeenCalledWith(child);
    } finally {
      unhost();
    }
  },
);
