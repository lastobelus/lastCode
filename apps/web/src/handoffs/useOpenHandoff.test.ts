import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type ChatFileAttachment,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { openHandoff } from "./useOpenHandoff";
import {
  recordHandoff,
  readThreadHandoffs,
  rememberHandoffBrowser,
  useHandoffsStore,
} from "./handoffsStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { applyPreviewServerSnapshot, resetPreviewStateForTests } from "~/previewStateStore";

vi.mock("~/state/entities", () => ({
  readThreadShell: () => ({ projectId: "project", worktreePath: "/workspace" }),
  readProjects: () => [],
}));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  readPreparedConnection: () => ({ httpBaseUrl: "https://environment.example" }),
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: vi.fn() },
}));
vi.mock("~/browser/browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({}),
  browserDefaultOpenProfileId: () => "default",
  browserDefaultOpenViewport: () => ({ width: 800, height: 600 }),
}));

const native = vi.hoisted(() => ({
  bridge: null as null | { navigate: ReturnType<typeof vi.fn> },
}));
vi.mock("~/components/preview/previewBridge", () => ({
  get previewBridge() {
    return native.bridge;
  },
}));

const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const snapshot = (url: string, tabId = "tab"): PreviewSessionSnapshot => ({
  threadId: ref.threadId,
  tabId,
  navStatus: { _tag: "Loading", url, title: "" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-11T00:00:00Z",
});
type Operations = Parameters<typeof openHandoff>[2];
const operations = () => ({
  openPreview: vi.fn<Operations["openPreview"]>(async () =>
    AsyncResult.success(snapshot("https://example.com/")),
  ),
  navigatePreview: vi.fn<Operations["navigatePreview"]>(async () =>
    AsyncResult.success(snapshot("https://environment.example/api/assets/fresh")),
  ),
  createAssetUrl: vi.fn<Operations["createAssetUrl"]>(async () =>
    AsyncResult.success({ relativeUrl: "/api/assets/fresh", expiresAt: 12345 }),
  ),
});
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);
beforeEach(() => {
  native.bridge = null;
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useHandoffsStore.setState({ byThreadKey: {} });
});

describe("opening a saved handoff", () => {
  it("reuses a relative file tab and preserves the full list", async () => {
    const ops = operations();
    useRightPanelStore.getState().open(ref, "handoffs");
    useRightPanelStore.getState().openFile(ref, "src/main.ts");
    const entry = recordHandoff(ref, { kind: "file", path: "/workspace/src/main.ts", line: 17 });
    await openHandoff(ref, entry, ops);
    expect(panel().surfaces).toHaveLength(2);
    expect(panel().activeSurfaceId).toBe("file:src/main.ts");
    expect(panel().surfaces.find((surface) => surface.kind === "file")).toMatchObject({
      revealLine: 17,
    });
    expect(ops.createAssetUrl).not.toHaveBeenCalled();
    expect(ops.openPreview).not.toHaveBeenCalled();
    expect(readThreadHandoffs(ref)[0]?.sequence).toBe(entry.sequence + 1);
  });
  it("refreshes HTML authorization before opening the normal file pane", async () => {
    const ops = operations();
    const entry = recordHandoff(ref, { kind: "file", path: "/workspace/mockup.html" });
    await openHandoff(ref, entry, ops);
    expect(ops.createAssetUrl).toHaveBeenCalledWith({
      environmentId: ref.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: ref.threadId,
          path: "/workspace/mockup.html",
        },
      },
    });
    expect(panel().activeSurfaceId).toBe("file:mockup.html");
    expect(ops.openPreview).not.toHaveBeenCalled();
  });
  it("renews an expired known browser file in the same tab", async () => {
    const ops = operations();
    const oldUrl = "https://environment.example/api/assets/expired";
    const entry = recordHandoff(ref, { kind: "file", path: "/workspace/mockup.html" });
    applyPreviewServerSnapshot(ref, snapshot(oldUrl));
    rememberHandoffBrowser(ref, "tab", entry.target, oldUrl);
    await openHandoff(ref, entry, ops);
    expect(ops.navigatePreview).toHaveBeenCalledWith({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        tabId: "tab",
        url: "https://environment.example/api/assets/fresh",
      },
    });
    expect(panel().activeSurfaceId).toBe("browser:tab");
    expect(ops.openPreview).not.toHaveBeenCalled();
    expect(readThreadHandoffs(ref)).toHaveLength(1);
  });
  it("renews a native browser through the desktop bridge", async () => {
    const ops = operations();
    native.bridge = { navigate: vi.fn(async () => undefined) };
    const oldUrl = "https://environment.example/api/assets/expired";
    const entry = recordHandoff(ref, { kind: "file", path: "/workspace/mockup.html" });
    applyPreviewServerSnapshot(ref, snapshot(oldUrl));
    rememberHandoffBrowser(ref, "tab", entry.target, oldUrl);
    await openHandoff(ref, entry, ops);
    expect(native.bridge.navigate).toHaveBeenCalledWith(
      JSON.stringify([ref.environmentId, ref.threadId, null, "tab"]),
      "https://environment.example/api/assets/fresh",
    );
    expect(ops.navigatePreview).not.toHaveBeenCalled();
    expect(panel().activeSurfaceId).toBe("browser:tab");
  });
  it("enriches completed page titles without capturing navigation or changing recency", () => {
    const url = "https://example.com/page";
    const entry = recordHandoff(ref, { kind: "url", url });
    rememberHandoffBrowser(ref, "tab", entry.target, url);
    applyPreviewServerSnapshot(ref, {
      ...snapshot(url),
      navStatus: { _tag: "Loading", url, title: "Previous page" },
    });
    expect(readThreadHandoffs(ref)).toEqual([entry]);
    applyPreviewServerSnapshot(ref, {
      ...snapshot(url),
      navStatus: { _tag: "Success", url, title: "New page" },
    });
    expect(readThreadHandoffs(ref)).toEqual([{ ...entry, title: "New page" }]);
    applyPreviewServerSnapshot(ref, {
      ...snapshot("https://elsewhere.example/"),
      navStatus: { _tag: "Success", url: "https://elsewhere.example/", title: "Other" },
    });
    expect(readThreadHandoffs(ref)).toEqual([{ ...entry, title: "New page" }]);
    applyPreviewServerSnapshot(ref, null);
  });
  it("does not hijack a file browser tab after it navigates away", async () => {
    const ops = operations();
    const entry = recordHandoff(ref, { kind: "file", path: "/workspace/mockup.html" });
    rememberHandoffBrowser(ref, "tab", entry.target, "https://environment.example/api/assets/old");
    applyPreviewServerSnapshot(ref, snapshot("https://elsewhere.example/"));
    await openHandoff(ref, entry, ops);
    expect(panel().activeSurfaceId).toBe("file:mockup.html");
    expect(ops.navigatePreview).not.toHaveBeenCalled();
  });
  it("reuses an exact URL tab without making asset requests", async () => {
    const ops = operations();
    const entry = recordHandoff(ref, { kind: "url", url: "http://localhost:8123/page?q=1#x" });
    applyPreviewServerSnapshot(ref, snapshot(entry.target.kind === "url" ? entry.target.url : ""));
    await openHandoff(ref, entry, ops);
    expect(panel().activeSurfaceId).toBe("browser:tab");
    expect(ops.openPreview).not.toHaveBeenCalled();
    expect(ops.createAssetUrl).not.toHaveBeenCalled();
  });
  it("reuses and titles an origin URL normalized by the browser", async () => {
    const ops = operations();
    const entry = recordHandoff(ref, { kind: "url", url: "https://example.com" });
    rememberHandoffBrowser(ref, "tab", entry.target, "https://example.com");
    applyPreviewServerSnapshot(ref, {
      ...snapshot("https://example.com/"),
      navStatus: { _tag: "Success", url: "https://example.com/", title: "Example" },
    });
    expect(readThreadHandoffs(ref)[0]?.title).toBe("Example");
    await openHandoff(ref, entry, ops);
    expect(panel().activeSurfaceId).toBe("browser:tab");
    expect(ops.openPreview).not.toHaveBeenCalled();
  });
  it("retries a failed URL in its existing tab", async () => {
    const ops = operations();
    const url = "https://example.com/recovered";
    const entry = recordHandoff(ref, { kind: "url", url });
    applyPreviewServerSnapshot(ref, {
      ...snapshot(url),
      navStatus: {
        _tag: "LoadFailed",
        url,
        title: "",
        code: -102,
        description: "Server unavailable",
      },
    });
    await openHandoff(ref, entry, ops);
    expect(ops.navigatePreview).toHaveBeenCalledWith({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, tabId: "tab", url },
    });
    expect(panel().activeSurfaceId).toBe("browser:tab");
    expect(ops.openPreview).not.toHaveBeenCalled();
    expect(readThreadHandoffs(ref)).toHaveLength(1);
  });
  it("opens unknown URLs unchanged without inferring an asset identity", async () => {
    const ops = operations();
    const entry = recordHandoff(ref, {
      kind: "url",
      url: "https://environment.example/api/assets/unknown?x=1",
    });
    await openHandoff(ref, entry, ops);
    expect(ops.openPreview.mock.calls[0]?.[0]).toMatchObject({
      input: { url: "https://environment.example/api/assets/unknown?x=1" },
    });
    expect(ops.createAssetUrl).not.toHaveBeenCalled();
  });
  it("retains PR pane routing", async () => {
    const ops = operations();
    const entry = recordHandoff(ref, {
      kind: "pull-request",
      projectId: "project",
      repository: "org/repo",
      number: 12,
    });
    await openHandoff(ref, entry, ops);
    expect(panel().surfaces[0]).toMatchObject({
      kind: "pull-request",
      repository: "org/repo",
      number: 12,
    });
    expect(ops.openPreview).not.toHaveBeenCalled();
  });
  it("opens attachments by identity", async () => {
    const ops = operations();
    const attachment = {
      id: "attachment",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      type: "file",
    } as ChatFileAttachment;
    const entry = recordHandoff(ref, { kind: "attachment", attachment });
    await openHandoff(ref, entry, ops);
    expect(panel().surfaces[0]).toMatchObject({ kind: "file", attachment });
    expect(ops.createAssetUrl.mock.calls[0]?.[0]).toMatchObject({
      input: { resource: { _tag: "attachment", attachmentId: "attachment" } },
    });
  });
  it("keeps missing files available for retry without moving recency", async () => {
    const ops = {
      ...operations(),
      createAssetUrl: vi.fn<Operations["createAssetUrl"]>(async () =>
        AsyncResult.failure(Cause.fail(new Error("File not found"))),
      ),
    };
    const entry = recordHandoff(ref, { kind: "file", path: "/workspace/missing.html" });
    await openHandoff(ref, entry, ops);
    expect(panel().surfaces).toEqual([]);
    expect(readThreadHandoffs(ref)).toEqual([entry]);
    expect(ops.openPreview).not.toHaveBeenCalled();
  });
});
