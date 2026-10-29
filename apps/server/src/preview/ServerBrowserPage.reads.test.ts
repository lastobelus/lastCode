import type { CDPSession, Frame, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const metadata = {
  url: "https://example.test/",
  title: "Test page",
  loading: false,
  visibleText: "continue",
  interactiveElements: [],
};
const pngHeader = (width: number, height: number) => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
};
const PNG_HEADER = pngHeader(1280, 800);
const UNSCALED_PNG_HEADER = pngHeader(2560, 1600);
const layout = {
  cssVisualViewport: { clientWidth: 2560, clientHeight: 1600, pageX: 10, pageY: 20, zoom: 1 },
};
const makeBrowser = (options: { nativeViewport?: boolean } = {}) => {
  const pageEvaluate = vi.fn().mockResolvedValue(metadata);
  const ariaSnapshot = vi.fn().mockResolvedValue('- button "continue" [ref=e1]');
  const send = vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
    switch (method) {
      case "Page.getLayoutMetrics":
        return Promise.resolve(layout);
      case "Page.captureScreenshot":
        return Promise.resolve({ data: UNSCALED_PNG_HEADER });
      case "Runtime.callFunctionOn":
        return Promise.resolve({ result: { value: PNG_HEADER } });
      case "Runtime.evaluate":
        return Promise.resolve({ result: { value: 42 } });
      default:
        return Promise.reject(new Error(`Unexpected CDP method: ${method}`));
    }
  });
  const mainFrame = {} as Frame;
  const dottedValues = vi.fn<() => Promise<Array<string>>>().mockResolvedValue([]);
  const maskingSend = vi.fn(async (method: string, params?: unknown) => {
    switch (method) {
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main" } } };
      case "Page.createIsolatedWorld":
        return {
          executionContextId:
            typeof params === "object" &&
            params !== null &&
            "worldName" in params &&
            params.worldName === "t3-preview-screenshot"
              ? 2
              : 1,
        };
      case "Runtime.evaluate":
        return { result: { value: await dottedValues() } };
      default:
        throw new Error(`Unexpected masking CDP method: ${method}`);
    }
  });
  const page = {
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    viewportSize: () => (options.nativeViewport ? null : { width: 2560, height: 1600 }),
    on: vi.fn(),
    evaluate: pageEvaluate,
    ariaSnapshot,
  } as unknown as Page;
  const cdp = {
    send: (method: string, params?: unknown) =>
      method === "Page.getFrameTree" ||
      method === "Page.createIsolatedWorld" ||
      (method === "Runtime.evaluate" &&
        typeof params === "object" &&
        params !== null &&
        "contextId" in params &&
        params.contextId === 1)
        ? maskingSend(method, params)
        : params === undefined
          ? send(method)
          : send(method, params),
  } as unknown as CDPSession;
  const snapshot = (
    options: { timeoutMs?: number; includeImage?: boolean; signal?: AbortSignal } = {},
  ) =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      ...options,
    });
  return { page, cdp, send, maskingSend, dottedValues, pageEvaluate, ariaSnapshot, snapshot };
};

const observeAbort = () => {
  const controller = new AbortController();
  const added = vi.spyOn(controller.signal, "addEventListener");
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const expectClean = () => {
    for (const [event, listener] of added.mock.calls) {
      expect(removed).toHaveBeenCalledWith(event, listener);
    }
    expect(vi.getTimerCount()).toBe(0);
  };
  return { controller, added, expectClean };
};

describe("bounded server browser reads", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    "snapshot metadata",
    "accessibility tree",
    "Page.getLayoutMetrics",
    "Page.captureScreenshot",
  ])("times out a stalled %s stage and permits a fresh snapshot", async (stage) => {
    const browser = makeBrowser({ nativeViewport: stage === "Page.getLayoutMetrics" });
    const stalled = deferred<never>();
    const abort = observeAbort();
    if (stage === "snapshot metadata") browser.pageEvaluate.mockReturnValueOnce(stalled.promise);
    else if (stage === "accessibility tree")
      browser.ariaSnapshot.mockReturnValueOnce(stalled.promise);
    else if (stage === "Page.getLayoutMetrics") browser.send.mockReturnValueOnce(stalled.promise);
    else browser.send.mockReturnValueOnce(stalled.promise);
    const failed = expect(
      browser.snapshot({ timeoutMs: 100, signal: abort.controller.signal }),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      message: expect.stringContaining(stage),
      detail: { stage, timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    abort.expectClean();
    if (stage === "Page.getLayoutMetrics")
      expect(browser.send).not.toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
    const fresh = await browser.snapshot({ signal: abort.controller.signal });
    expect(fresh).toMatchObject({
      title: "Test page",
      screenshot: { data: PNG_HEADER, width: 1280, height: 800 },
    });
    expect(String(fresh.accessibilityTree)).toContain("[ref=t3-");
    abort.expectClean();
    // The timed-out protocol response can reject after the replacement read finishes.
    stalled.reject(new Error("Late browser response"));
    await vi.advanceTimersByTimeAsync(0);
    abort.expectClean();
  });

  it.each(["before", "after"])("bounds stalled dotted values %s the tree", async (when) => {
    const browser = makeBrowser();
    const stalled = deferred<Array<string>>();
    const abort = observeAbort();
    if (when === "after") browser.dottedValues.mockResolvedValueOnce([]);
    browser.dottedValues.mockReturnValueOnce(stalled.promise);
    const failed = expect(
      browser.snapshot({ timeoutMs: 100, signal: abort.controller.signal }),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { stage: `dotted values ${when} snapshot`, timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    abort.expectClean();
    await expect(browser.snapshot()).resolves.toMatchObject({ title: "Test page" });
    stalled.reject(new Error("Late masking response"));
    await vi.advanceTimersByTimeAsync(0);
    abort.expectClean();
  });

  it("retries changed dotted values and masks image-free snapshots", async () => {
    const browser = makeBrowser();
    browser.dottedValues.mockResolvedValueOnce(["old-secret"]).mockResolvedValue(["new-secret"]);
    browser.ariaSnapshot
      .mockResolvedValueOnce('- button "old-secret" [ref=e1]')
      .mockResolvedValue('- button "new-secret" [ref=e1]');
    browser.pageEvaluate.mockResolvedValue({ ...metadata, visibleText: "new-secret" });
    const result = await browser.snapshot({ includeImage: false });
    expect(result.visibleText).toBe("••••••••");
    expect(result.accessibilityTree).toContain('button "••••••••" [ref=t3-');
    expect(result).not.toHaveProperty("screenshot");
    expect(browser.ariaSnapshot).toHaveBeenCalledTimes(2);
    expect(browser.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a masking read after its snapshot is aborted", async () => {
    const browser = makeBrowser();
    const stalled = deferred<Array<string>>();
    const abort = observeAbort();
    browser.dottedValues.mockResolvedValueOnce([]).mockReturnValueOnce(stalled.promise);
    const failed = expect(
      browser.snapshot({ signal: abort.controller.signal }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.dottedValues).toHaveBeenCalledTimes(2);
    abort.controller.abort();
    await failed;
    abort.expectClean();
    await expect(browser.snapshot()).resolves.toMatchObject({ title: "Test page" });
    const treeCalls = browser.ariaSnapshot.mock.calls.length;
    stalled.resolve(["late-secret"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.ariaSnapshot).toHaveBeenCalledTimes(treeCalls);
    abort.expectClean();
  });

  it("bounds a standalone stalled capture and permits another capture", async () => {
    const browser = makeBrowser();
    const stalled = deferred<never>();
    const abort = observeAbort();
    browser.send.mockReturnValueOnce(stalled.promise);
    const options = {
      format: "jpeg",
      quality: 70,
      timeoutMs: 100,
      signal: abort.controller.signal,
    } as const;
    const failed = expect(
      ServerBrowserPage.captureViewport(browser.cdp, options),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { stage: "Page.captureScreenshot", timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    abort.expectClean();
    expect(await ServerBrowserPage.captureViewport(browser.cdp, options)).toBe(UNSCALED_PNG_HEADER);
    expect(browser.send.mock.calls).toEqual([
      ["Page.captureScreenshot", { format: "jpeg", quality: 70 }],
      ["Page.captureScreenshot", { format: "jpeg", quality: 70 }],
    ]);
    abort.expectClean();
    stalled.reject(new Error("Late capture failure"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shares the native snapshot budget across layout and screenshot", async () => {
    const browser = makeBrowser({ nativeViewport: true });
    const metrics = deferred<typeof layout>();
    browser.send
      .mockReturnValueOnce(metrics.promise)
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const failed = expect(browser.snapshot({ timeoutMs: 100 })).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { stage: "Page.captureScreenshot", timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(80);
    metrics.resolve(layout);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
    await vi.advanceTimersByTimeAsync(19);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the snapshot deadline with shrinking after the screenshot completes", async () => {
    const browser = makeBrowser();
    const screenshot = deferred<{ data: string }>();
    browser.send
      .mockReturnValueOnce(screenshot.promise)
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const failed = expect(browser.snapshot({ timeoutMs: 100 })).rejects.toMatchObject({
      detail: { stage: "Runtime.callFunctionOn", timeoutMs: 100 },
    });
    await vi.advanceTimersByTimeAsync(80);
    screenshot.resolve({ data: UNSCALED_PNG_HEADER });
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.maskingSend).toHaveBeenCalledWith("Page.createIsolatedWorld", {
      frameId: "main",
      worldName: "t3-preview-screenshot",
    });
    expect(browser.send).toHaveBeenCalledWith(
      "Runtime.callFunctionOn",
      expect.objectContaining({
        executionContextId: 2,
        arguments: [{ value: UNSCALED_PNG_HEADER }, { value: 1280 }, { value: 800 }],
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips capture and shrinking when the snapshot does not include an image", async () => {
    const browser = makeBrowser();
    browser.send.mockReturnValue(new Promise<never>(() => {}));
    const result = await browser.snapshot({ includeImage: false });
    expect(result).toMatchObject(metadata);
    expect(result).not.toHaveProperty("screenshot");
    expect(browser.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up all parallel stages immediately when one fails", async () => {
    const browser = makeBrowser();
    const abort = observeAbort();
    const original = new Error("Browser disconnected");
    browser.pageEvaluate.mockRejectedValueOnce(original);
    browser.ariaSnapshot.mockReturnValueOnce(new Promise<never>(() => {}));
    browser.send.mockReturnValueOnce(new Promise<never>(() => {}));
    await expect(browser.snapshot({ signal: abort.controller.signal })).rejects.toBe(original);
    abort.expectClean();
  });

  it("aborts a native snapshot and never starts capture after delayed layout", async () => {
    const browser = makeBrowser({ nativeViewport: true });
    const abort = observeAbort();
    const metrics = deferred<typeof layout>();
    browser.send.mockReturnValueOnce(metrics.promise);
    const failed = expect(
      browser.snapshot({ signal: abort.controller.signal }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.send).toHaveBeenCalledWith("Page.getLayoutMetrics");
    expect(browser.pageEvaluate).not.toHaveBeenCalled();
    expect(browser.ariaSnapshot).not.toHaveBeenCalled();
    abort.controller.abort();
    await failed;
    abort.expectClean();
    metrics.resolve(layout);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.send.mock.calls).toEqual([["Page.getLayoutMetrics"]]);
    await expect(browser.snapshot()).resolves.toMatchObject({ title: "Test page" });
    abort.expectClean();
  });

  it.each(["snapshot", "capture", "evaluate"])(
    "does not dispatch a pre-aborted %s read",
    async (operation) => {
      const browser = makeBrowser();
      const abort = observeAbort();
      abort.controller.abort();
      const result =
        operation === "snapshot"
          ? browser.snapshot({ signal: abort.controller.signal })
          : operation === "capture"
            ? ServerBrowserPage.captureViewport(browser.cdp, {
                format: "png",
                signal: abort.controller.signal,
              })
            : ServerBrowserPage.evaluate(
                browser.cdp,
                { expression: "42" },
                { signal: abort.controller.signal },
              );
      await expect(result).rejects.toMatchObject({
        tag: "PreviewAutomationControlInterruptedError",
      });
      expect(browser.pageEvaluate).not.toHaveBeenCalled();
      expect(browser.ariaSnapshot).not.toHaveBeenCalled();
      expect(browser.send).not.toHaveBeenCalled();
      expect(abort.added).not.toHaveBeenCalled();
      abort.expectClean();
    },
  );

  it("bounds an unanswered Runtime.evaluate and preserves a later read", async () => {
    const browser = makeBrowser();
    const stalled = deferred<never>();
    const abort = observeAbort();
    browser.send.mockReturnValueOnce(stalled.promise);
    const failed = expect(
      ServerBrowserPage.evaluate(
        browser.cdp,
        { expression: "new Promise(() => {})" },
        { timeoutMs: 100, signal: abort.controller.signal },
      ),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { stage: "Runtime.evaluate", timeoutMs: 100 },
    });
    expect(browser.send).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "new Promise(() => {})",
      awaitPromise: true,
      returnByValue: true,
      timeout: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    abort.expectClean();
    expect(
      await ServerBrowserPage.evaluate(
        browser.cdp,
        { expression: "42" },
        { signal: abort.controller.signal },
      ),
    ).toBe(42);
    abort.expectClean();
    stalled.reject(new Error("Late evaluation failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.send.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Runtime.terminateExecution",
      "Runtime.evaluate",
    ]);
  });

  it.each(["capture", "evaluate"])("cleans up an aborted %s read", async (operation) => {
    const browser = makeBrowser();
    const abort = observeAbort();
    const stalled = deferred<never>();
    browser.send.mockReturnValueOnce(stalled.promise);
    const failed = expect(
      operation === "capture"
        ? ServerBrowserPage.captureViewport(browser.cdp, {
            format: "png",
            signal: abort.controller.signal,
          })
        : ServerBrowserPage.evaluate(
            browser.cdp,
            { expression: "42" },
            { signal: abort.controller.signal },
          ),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    abort.controller.abort();
    await failed;
    abort.expectClean();
    stalled.reject(new Error("Late aborted read failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await ServerBrowserPage.evaluate(browser.cdp, { expression: "42" })).toBe(42);
    abort.expectClean();
  });

  it.each(["capture", "evaluate"])("uses the default %s budget", async (operation) => {
    const browser = makeBrowser();
    browser.send.mockReturnValueOnce(new Promise<never>(() => {}));
    const timeoutMs = operation === "capture" ? 3_000 : 10_000;
    const failed = expect(
      operation === "capture"
        ? ServerBrowserPage.captureViewport(browser.cdp, { format: "png" })
        : ServerBrowserPage.evaluate(browser.cdp, { expression: "42" }),
    ).rejects.toMatchObject({ detail: { timeoutMs } });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports the native capture relay deadline as a timeout", () => {
    const error = ServerBrowserPage.toOperationError(
      new Error(
        "Protocol error (Page.captureScreenshot): Desktop browser Page.captureScreenshot exceeded its 8000ms deadline.",
      ),
    );
    expect(error).toMatchObject({ tag: "PreviewAutomationTimeoutError" });
  });

  it("never clicks after canceled locator preparation eventually completes", async () => {
    const scrolling = deferred<void>();
    const locator = {
      scrollIntoViewIfNeeded: vi.fn(() => scrolling.promise),
      boundingBox: vi.fn(),
      click: vi.fn(),
    };
    const page = { locator: () => locator } as unknown as Page;
    const abort = new AbortController();
    const failed = expect(
      ServerBrowserPage.click(page, { selector: "button" }, undefined, abort.signal),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    abort.abort();
    await failed;
    scrolling.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(locator.boundingBox).not.toHaveBeenCalled();
    expect(locator.click).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never inserts text after canceled target focus eventually completes", async () => {
    const focusing = deferred<boolean>();
    const target = { evaluate: vi.fn(() => focusing.promise) };
    const page = {
      locator: () => target,
      keyboard: { insertText: vi.fn(), press: vi.fn() },
    } as unknown as Page;
    const abort = new AbortController();
    const failed = expect(
      ServerBrowserPage.type(page, { selector: "input", text: "late" }, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    focusing.resolve(true);
    await failed;
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it("bounds a stalled text condition without poisoning subsequent waits", async () => {
    const browser = makeBrowser();
    browser.pageEvaluate.mockReturnValueOnce(new Promise<never>(() => {}));
    const failed = expect(
      ServerBrowserPage.waitFor(browser.page, { text: "continue", timeoutMs: 100 }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    browser.pageEvaluate.mockResolvedValueOnce(true);
    await expect(
      ServerBrowserPage.waitFor(browser.page, { text: "continue", timeoutMs: 100 }),
    ).resolves.toBeUndefined();
  });

  it("honors an explicit long awaitPromise evaluation budget", async () => {
    const browser = makeBrowser();
    const reply = deferred<{ result: { value: number } }>();
    browser.send.mockReturnValueOnce(reply.promise);
    const result = ServerBrowserPage.evaluate(
      browser.cdp,
      { expression: "slow()", awaitPromise: true },
      { timeoutMs: 40_000 },
    );
    expect(browser.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ timeout: 40_000 }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    reply.resolve({ result: { value: 42 } });
    expect(await result).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps oversized configured read budgets below the broker deadline", async () => {
    const browser = makeBrowser();
    browser.pageEvaluate.mockReturnValueOnce(new Promise<never>(() => {}));
    const failed = expect(
      browser.snapshot({ includeImage: false, timeoutMs: 60_000 }),
    ).rejects.toMatchObject({ detail: { timeoutMs: 10_000 } });
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["response", "protocol error"])(
    "rejects a late evaluation %s even before the timer callback runs",
    async (completion) => {
      const browser = makeBrowser();
      const reply = deferred<{ result: { value: number } }>();
      const abort = observeAbort();
      browser.send.mockReturnValueOnce(reply.promise);
      const failed = expect(
        ServerBrowserPage.evaluate(
          browser.cdp,
          { expression: "42" },
          {
            timeoutMs: 100,
            signal: abort.controller.signal,
          },
        ),
      ).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { stage: "Runtime.evaluate", timeoutMs: 100 },
      });
      // Move the deadline clock without running timers, like a delayed Node callback.
      vi.setSystemTime(100);
      if (completion === "response") reply.resolve({ result: { value: 42 } });
      else reply.reject(new Error("Protocol error (Runtime.evaluate): Execution was terminated"));
      await failed;
      abort.expectClean();
    },
  );

  it("cleans up a synchronously thrown protocol failure", async () => {
    const browser = makeBrowser();
    const abort = observeAbort();
    const failure = new Error("Session detached");
    browser.send.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      ServerBrowserPage.evaluate(
        browser.cdp,
        { expression: "42" },
        { signal: abort.controller.signal },
      ),
    ).rejects.toBe(failure);
    abort.expectClean();
  });
});
