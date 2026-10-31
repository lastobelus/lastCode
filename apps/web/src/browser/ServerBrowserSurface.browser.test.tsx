import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

import "~/index.css";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(input: PreviewStreamInput) => void>(),
  events: null as PreviewStreamEvents | null,
  painted: null as (() => void) | null,
  connect: vi.fn((_input: unknown, _callbacks: PreviewStreamEvents) => ({
    send: vi.fn<(input: PreviewStreamInput) => void>(),
    stop: vi.fn(),
  })),
  access: { httpBaseUrl: "https://environment.example" },
}));

vi.mock("@t3tools/client-runtime/preview/server-browser-stream", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/preview/server-browser-stream")>()),
  createPreviewStreamClient: (
    ...[input, callbacks]: Parameters<
      typeof import("@t3tools/client-runtime/preview/server-browser-stream").createPreviewStreamClient
    >
  ) => {
    mocks.events = callbacks;
    const client = mocks.connect(input, callbacks);
    client.send = mocks.send;
    return client;
  },
  createPreviewFramePainter: (
    ...[_canvas, onPainted]: Parameters<
      typeof import("@t3tools/client-runtime/preview/server-browser-stream").createPreviewFramePainter
    >
  ) => {
    mocks.painted = onPainted ?? null;
    return { paint: vi.fn(), stop: vi.fn() };
  },
}));

vi.mock("~/state/previewStream", () => ({
  usePreviewStreamAccess: () => mocks.access,
  refreshPreviewStreamAccess: vi.fn(),
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

describe("server viewer document visibility", () => {
  it("retains the stream and input after taking control", async () => {
    mocks.send.mockClear();
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
    mocks.send.mockClear();
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

async function renderSurface() {
  mocks.send.mockReset();
  mocks.connect.mockReset();
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px;";
  await using stack = new AsyncDisposableStack();
  stack.use(
    await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-1")}
        threadId={ThreadId.make("thread-1")}
        tabId="tab-1"
        visible
      />,
      { container },
    ),
  );
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("The surface did not render its canvas.");
  // The stream connects once the surface has measured its size.
  await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalled());
  return Object.assign(stack.move(), { canvas });
}

const mouseUp = (canvas: HTMLCanvasElement, button: number) => {
  const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  canvas.dispatchEvent(event);
  return event;
};

describe("ServerBrowserSurface", () => {
  it("routes mouse thumb buttons to the preview's history instead of the app", async () => {
    await using surface = await renderSurface();
    const { canvas } = surface;

    expect(mouseUp(canvas, 3).defaultPrevented).toBe(true);
    expect(mouseUp(canvas, 4).defaultPrevented).toBe(true);
    expect(mocks.send.mock.calls).toEqual([
      [{ type: "history", delta: -1 }],
      [{ type: "history", delta: 1 }],
    ]);
  });

  it("leaves other mouse buttons alone", async () => {
    await using surface = await renderSurface();
    const { canvas } = surface;

    expect(mouseUp(canvas, 0).defaultPrevented).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not forward thumb-button presses to the page", async () => {
    await using surface = await renderSurface();
    const { canvas } = surface;
    canvas.width = 400;
    canvas.height = 300;
    // Synthetic pointers have no active pointer id to capture.
    canvas.setPointerCapture = () => undefined;
    mocks.painted?.();
    mocks.events?.onViewport({ width: 400, height: 300 });
    mocks.events?.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
    const { left, top } = canvas.getBoundingClientRect();
    const press = (type: "pointerdown" | "pointerup", button: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          button,
          buttons: type === "pointerdown" ? 1 << button : 0,
          clientX: left + 10,
          clientY: top + 10,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
    const mouseInputs = () => mocks.send.mock.calls.filter(([input]) => input.type === "mouse");

    for (const button of [3, 4]) {
      press("pointerdown", button);
      press("pointerup", button);
    }
    expect(mouseInputs()).toEqual([]);

    press("pointerdown", 0);
    expect(mouseInputs()).not.toEqual([]);
  });
});
