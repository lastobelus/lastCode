import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceBrowserPreview } from "./WorkspaceBrowserPreview";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));
vi.mock("~/assets/assetUrls", () => ({ useAssetUrlRefresh: () => refresh }));

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
