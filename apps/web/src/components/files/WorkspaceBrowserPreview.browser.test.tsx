import { act, render } from "../../../test/render";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceBrowserPreview } from "./WorkspaceBrowserPreview";

const { refresh, useAssetUrlRefresh } = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<string | null>>(),
  useAssetUrlRefresh: vi.fn<typeof import("~/assets/assetUrls").useAssetUrlRefresh>(),
}));
vi.mock("~/assets/assetUrls", async () => ({
  resolveAssetUrl: (await import("@t3tools/client-runtime/state/assets")).resolveAssetUrl,
  useAssetUrlRefresh,
  useAssetUrlState: vi.fn(),
  useAssetUrls: vi.fn(),
}));

const environmentId = EnvironmentId.make("test-environment");
const props = {
  environmentId,
  threadRef: { environmentId, threadId: ThreadId.make("test-thread") },
  draft: false,
  absolutePath: "/workspace/report.html",
  workspaceRoot: "/workspace",
  title: "report.html",
  revision: 0,
};

describe("workspace document reading session", () => {
  function setup() {
    useAssetUrlRefresh.mockReset().mockReturnValue(refresh);
    refresh
      .mockReset()
      .mockResolvedValue("https://environment.test/report.html?signature=original");
  }

  it("loads a draft document from its workspace before its thread exists on the server", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    useAssetUrlRefresh.mockImplementation((_environmentId, resource) => async () => {
      if (resource?._tag !== "draft-workspace-file") return null;
      return "https://environment.test/draft-report.html?signature=draft";
    });

    await screen.rerender(<WorkspaceBrowserPreview {...props} draft />);

    expect(useAssetUrlRefresh).toHaveBeenCalledWith(environmentId, {
      _tag: "draft-workspace-file",
      cwd: props.workspaceRoot,
      path: props.absolutePath,
    });
    expect(container.querySelector("iframe")!.src).toBe(
      "https://environment.test/draft-report.html?signature=draft&preview-revision=0",
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("keeps the same mounted document through surrounding thread updates", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    const frame = container.querySelector("iframe")!;
    // A tool completion rerenders the parent, with new object identities but
    // no user reload. Preserving the frame preserves its scroll and form state.
    await screen.rerender(
      <WorkspaceBrowserPreview {...props} threadRef={{ ...props.threadRef }} />,
    );
    expect(container.querySelector("iframe")!).toBe(frame);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the loaded document across reconnects and uses the latest authorization on reload", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    const frame = container.querySelector("iframe")!;
    const offline = vi.fn(async () => null);
    useAssetUrlRefresh.mockReturnValue(offline);
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    expect(container.querySelector("iframe")!).toBe(frame);
    expect(offline).not.toHaveBeenCalled();

    const recovered = vi.fn(async () => "https://environment.test/report.html?signature=recovered");
    useAssetUrlRefresh.mockReturnValue(recovered);
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    expect(container.querySelector("iframe")!).toBe(frame);
    expect(recovered).not.toHaveBeenCalled();

    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={1} />);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")!).not.toBe(frame);
    expect(container.querySelector("iframe")!.src).toContain("signature=recovered");
  });

  it("recovers an initially offline document when authorization becomes available", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    refresh.mockResolvedValue(null);
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    const recovered = vi.fn(async () => "https://environment.test/report.html?signature=recovered");
    useAssetUrlRefresh.mockReturnValue(recovered);
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")!.src).toContain("signature=recovered");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("retries an interrupted explicit reload after reconnecting and ignores its obsolete result", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    const originalFrame = container.querySelector("iframe")!;
    let completeInterrupted!: (url: string) => void;
    refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        completeInterrupted = resolve;
      }),
    );
    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={1} />);
    expect(container.querySelector("iframe")!).toBe(originalFrame);

    const offline = vi.fn(async () => null);
    useAssetUrlRefresh.mockReturnValue(offline);
    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={1} />);
    expect(offline).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")!).toBe(originalFrame);
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    const recovered = vi.fn(async () => "https://environment.test/report.html?signature=recovered");
    useAssetUrlRefresh.mockReturnValue(recovered);
    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={1} />);
    expect(recovered).toHaveBeenCalledTimes(1);
    const refreshedFrame = container.querySelector("iframe")!;
    expect(refreshedFrame).not.toBe(originalFrame);
    expect(refreshedFrame.src).toBe(
      "https://environment.test/report.html?signature=recovered&preview-revision=1",
    );
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);

    await act(async () =>
      completeInterrupted("https://environment.test/report.html?signature=old"),
    );
    expect(container.querySelector("iframe")!).toBe(refreshedFrame);
    expect(refreshedFrame.src).toContain("signature=recovered");
  });

  it("reauthorizes and replaces the document only on explicit reload", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    const frame = container.querySelector("iframe")!;
    refresh.mockResolvedValue("https://environment.test/report.html?signature=renewed");
    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={1} />);
    expect(container.querySelector("iframe")!).not.toBe(frame);
    expect(container.querySelector("iframe")!.src).toBe(
      "https://environment.test/report.html?signature=renewed&preview-revision=1",
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("cache-busts a reload even when authorization returns the same URL", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    const frame = container.querySelector("iframe")!;
    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={1} />);
    expect(container.querySelector("iframe")!).not.toBe(frame);
  });

  it("keeps the readable document on renewal failure and permits another reload", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    const frame = container.querySelector("iframe")!;
    refresh.mockRejectedValueOnce(new Error("offline"));
    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={1} />);
    expect(container.querySelector("iframe")!).toBe(frame);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await screen.rerender(<WorkspaceBrowserPreview {...props} revision={2} />);
    expect(container.querySelector("iframe")!).not.toBe(frame);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("discards an obsolete authorization when switching document identity", async () => {
    setup();
    await using screen = await render(<></>, { router: false });
    const { container } = screen;
    let completeOld!: (url: string) => void;
    refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        completeOld = resolve;
      }),
    );
    await screen.rerender(<WorkspaceBrowserPreview {...props} />);
    refresh.mockResolvedValue("https://environment.test/other.html");
    await screen.rerender(
      <WorkspaceBrowserPreview key="other" {...props} absolutePath="/workspace/other.html" />,
    );
    const frame = container.querySelector("iframe")!;
    await act(async () => completeOld("https://environment.test/report.html"));
    expect(container.querySelector("iframe")!).toBe(frame);
    expect(frame.src).toContain("/other.html");
  });
});
