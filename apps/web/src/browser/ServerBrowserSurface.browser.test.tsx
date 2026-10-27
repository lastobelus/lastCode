import { EnvironmentId } from "@t3tools/contracts";
import type { PreviewStreamEvents } from "@t3tools/client-runtime/preview/server-browser-stream";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

import "~/index.css";

const mocks = vi.hoisted(() => ({
  connect: vi.fn((_input: unknown, _callbacks: PreviewStreamEvents) => ({
    send: vi.fn(),
    stop: vi.fn(),
  })),
  access: { httpBaseUrl: "https://environment.example" },
}));

vi.mock("@t3tools/client-runtime/preview/server-browser-stream", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/preview/server-browser-stream")>()),
  createPreviewStreamClient: mocks.connect,
  createPreviewFramePainter: () => ({ paint: vi.fn(), stop: vi.fn() }),
}));

vi.mock("~/state/previewStream", () => ({
  usePreviewStreamAccess: () => mocks.access,
  refreshPreviewStreamAccess: vi.fn(),
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

describe("server viewer document visibility", () => {
  it("retains the stream and input after taking control", async () => {
    mocks.connect.mockClear();
    const container = document.createElement("div");
    container.style.cssText = "width:640px;height:480px;position:relative";
    await using screen = await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("viewer-environment")}
        threadId="viewer-thread"
        tabId="viewer-tab"
        className="h-full w-full"
        visible
      />,
      { container },
    );
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
    const first = mocks.connect.mock.results[0]!.value;
    const callbacks = mocks.connect.mock.calls[0]![1];
    await act(() =>
      callbacks.onControl?.({ canOperate: true, controller: "agent", generation: 0, dialog: null }),
    );
    await screen.getByRole("button", { name: "Take control" }).click();
    expect(first.send).toHaveBeenCalledWith({ type: "takeControl" });
    await act(() =>
      callbacks.onControl?.({
        canOperate: true,
        controller: "taking-control",
        generation: 1,
        dialog: null,
      }),
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("Taking control…");
    await expect.element(screen.getByRole("textbox", { name: "Browser page" })).toBeDisabled();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(first.send).toHaveBeenCalledWith({ type: "releaseControl" });
    await act(() =>
      callbacks.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null }),
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("You have control");
    expect(first.stop).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await screen.getByRole("textbox", { name: "Browser page" }).fill("viewer input");
    expect(first.send).toHaveBeenCalledWith({ type: "text", text: "viewer input" });
  });

  it("releases the hidden client viewer and reconnects when the user returns", async () => {
    mocks.connect.mockClear();
    let visibility: DocumentVisibilityState = "visible";
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const container = document.createElement("div");
    container.style.cssText = "width:640px;height:480px;position:relative";
    await using _screen = await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("viewer-environment")}
        threadId="viewer-thread"
        tabId="viewer-tab"
        visible
      />,
      { container },
    );
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
    const first = mocks.connect.mock.results[0]!.value;
    await act(async () => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(first.stop).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2));
    expect(mocks.connect.mock.calls[1]![0]).toEqual(mocks.connect.mock.calls[0]![0]);
  });
});
