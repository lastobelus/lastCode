import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceBrowserPreview } from "./WorkspaceBrowserPreview";

const { refresh, useAssetUrlRefresh } = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<string | null>>(),
  useAssetUrlRefresh: vi.fn<() => () => Promise<string | null>>(),
}));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrlRefresh }));

const environmentId = EnvironmentId.make("test-environment");
const props = {
  environmentId,
  threadRef: { environmentId, threadId: ThreadId.make("test-thread") },
  absolutePath: "/workspace/report.html",
  workspaceRoot: "/workspace",
  title: "report.html",
  revision: 0,
};

describe("workspace document reading session", () => {
  let renderer: ReactTestRenderer;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useAssetUrlRefresh.mockReset().mockReturnValue(refresh);
    refresh
      .mockReset()
      .mockResolvedValue("https://environment.test/report.html?signature=original");
  });
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount());
    vi.unstubAllGlobals();
  });
  const open = async () => {
    await act(async () => {
      renderer = create(<WorkspaceBrowserPreview {...props} />);
    });
  };

  it("keeps the same mounted document through surrounding thread updates", async () => {
    await open();
    const frame = renderer.root.findByType("iframe");
    // A tool completion rerenders the parent, with new object identities but
    // no user reload. Preserving the frame preserves its scroll and form state.
    await act(async () => {
      renderer.update(<WorkspaceBrowserPreview {...props} threadRef={{ ...props.threadRef }} />);
    });
    expect(renderer.root.findByType("iframe")).toBe(frame);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the loaded document across reconnects and uses the latest authorization on reload", async () => {
    await open();
    const frame = renderer.root.findByType("iframe");
    const offline = vi.fn(async () => null);
    useAssetUrlRefresh.mockReturnValue(offline);
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} />));
    expect(renderer.root.findByType("iframe")).toBe(frame);
    expect(offline).not.toHaveBeenCalled();

    const recovered = vi.fn(async () => "https://environment.test/report.html?signature=recovered");
    useAssetUrlRefresh.mockReturnValue(recovered);
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} />));
    expect(renderer.root.findByType("iframe")).toBe(frame);
    expect(recovered).not.toHaveBeenCalled();

    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} revision={1} />));
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("iframe")).not.toBe(frame);
    expect(renderer.root.findByType("iframe").props.src).toContain("signature=recovered");
  });

  it("recovers an initially offline document when authorization becomes available", async () => {
    refresh.mockResolvedValue(null);
    await open();
    expect(renderer.root.findAllByType("iframe")).toHaveLength(0);
    expect(renderer.root.findByProps({ role: "alert" })).toBeDefined();

    const recovered = vi.fn(async () => "https://environment.test/report.html?signature=recovered");
    useAssetUrlRefresh.mockReturnValue(recovered);
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} />));
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("iframe").props.src).toContain("signature=recovered");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });

  it("retries an interrupted explicit reload after reconnecting and ignores its obsolete result", async () => {
    await open();
    const originalFrame = renderer.root.findByType("iframe");
    let completeInterrupted!: (url: string) => void;
    refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        completeInterrupted = resolve;
      }),
    );
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} revision={1} />));
    expect(renderer.root.findByType("iframe")).toBe(originalFrame);

    const offline = vi.fn(async () => null);
    useAssetUrlRefresh.mockReturnValue(offline);
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} revision={1} />));
    expect(offline).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByType("iframe")).toBe(originalFrame);
    expect(renderer.root.findByProps({ role: "status" })).toBeDefined();

    const recovered = vi.fn(async () => "https://environment.test/report.html?signature=recovered");
    useAssetUrlRefresh.mockReturnValue(recovered);
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} revision={1} />));
    expect(recovered).toHaveBeenCalledTimes(1);
    const refreshedFrame = renderer.root.findByType("iframe");
    expect(refreshedFrame).not.toBe(originalFrame);
    expect(refreshedFrame.props.src).toBe(
      "https://environment.test/report.html?signature=recovered&preview-revision=1",
    );
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(0);

    await act(async () =>
      completeInterrupted("https://environment.test/report.html?signature=old"),
    );
    expect(renderer.root.findByType("iframe")).toBe(refreshedFrame);
    expect(refreshedFrame.props.src).toContain("signature=recovered");
  });

  it("reauthorizes and replaces the document only on explicit reload", async () => {
    await open();
    const frame = renderer.root.findByType("iframe");
    refresh.mockResolvedValue("https://environment.test/report.html?signature=renewed");
    await act(async () => {
      renderer.update(<WorkspaceBrowserPreview {...props} revision={1} />);
    });
    expect(renderer.root.findByType("iframe")).not.toBe(frame);
    expect(renderer.root.findByType("iframe").props.src).toBe(
      "https://environment.test/report.html?signature=renewed&preview-revision=1",
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cache-busts a reload even when authorization returns the same URL", async () => {
    await open();
    const frame = renderer.root.findByType("iframe");
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} revision={1} />));
    expect(renderer.root.findByType("iframe")).not.toBe(frame);
  });

  it("keeps the readable document on renewal failure and permits another reload", async () => {
    await open();
    const frame = renderer.root.findByType("iframe");
    refresh.mockRejectedValueOnce(new Error("offline"));
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} revision={1} />));
    expect(renderer.root.findByType("iframe")).toBe(frame);
    expect(renderer.root.findByProps({ role: "status" })).toBeDefined();
    await act(async () => renderer.update(<WorkspaceBrowserPreview {...props} revision={2} />));
    expect(renderer.root.findByType("iframe")).not.toBe(frame);
    expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(0);
  });

  it("discards an obsolete authorization when switching document identity", async () => {
    let completeOld!: (url: string) => void;
    refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        completeOld = resolve;
      }),
    );
    await open();
    refresh.mockResolvedValue("https://environment.test/other.html");
    await act(async () =>
      renderer.update(
        <WorkspaceBrowserPreview key="other" {...props} absolutePath="/workspace/other.html" />,
      ),
    );
    const frame = renderer.root.findByType("iframe");
    await act(async () => completeOld("https://environment.test/report.html"));
    expect(renderer.root.findByType("iframe")).toBe(frame);
    expect(frame.props.src).toContain("/other.html");
  });
});
