import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  frameDocument,
  hasInlineStyle,
  isElement,
  observeFrameDocuments,
  pickInDocument,
  topViewportPoint,
  topViewportRect,
} from "./FramePicking.ts";

class Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
  get left() {
    return this.x;
  }
  get top() {
    return this.y;
  }
  get right() {
    return this.x + this.width;
  }
  get bottom() {
    return this.y + this.height;
  }
}

function fixture() {
  const style = {
    paddingLeft: "2px",
    paddingTop: "2px",
    paddingRight: "2px",
    paddingBottom: "2px",
  };
  const top = {
    defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style },
  } as unknown as Document;
  const frame = {
    nodeType: 1,
    localName: "iframe",
    isConnected: true,
    ownerDocument: top,
    offsetWidth: 112,
    offsetHeight: 112,
    clientWidth: 104,
    clientHeight: 104,
    clientLeft: 4,
    clientTop: 4,
    getBoundingClientRect: () => new Rect(100, 50, 224, 224),
    contentDocument: null as Document | null,
  };
  const child = {
    defaultView: {
      innerWidth: 100,
      innerHeight: 100,
      frameElement: frame,
      getComputedStyle: () => ({
        paddingLeft: "0px",
        paddingTop: "0px",
        paddingRight: "0px",
        paddingBottom: "0px",
      }),
    },
  } as unknown as Document;
  frame.contentDocument = child;
  const element = {
    nodeType: 1,
    localName: "button",
    style: {},
    isConnected: true,
    ownerDocument: child,
    getBoundingClientRect: () => new Rect(10, 20, 30, 40),
  } as unknown as Element;
  return { top, frame, child, element };
}

beforeEach(() => vi.stubGlobal("DOMRect", Rect));
afterEach(() => vi.unstubAllGlobals());

describe("frame picking coordinates", () => {
  it("includes scaled iframe borders and padding in selected rects and pointer coordinates", () => {
    const { top, element } = fixture();
    expect(topViewportRect(element, top)).toEqual(new Rect(132, 102, 60, 80));
    expect(
      topViewportPoint({ target: element, clientX: 15, clientY: 25 } as unknown as MouseEvent, top),
    ).toEqual({ x: 142, y: 112 });
  });

  it("clips through nested frame viewports before translating to the top viewport", () => {
    const { top, child } = fixture();
    const nestedFrame = {
      localName: "iframe",
      isConnected: true,
      ownerDocument: child,
      offsetWidth: 44,
      offsetHeight: 44,
      clientWidth: 40,
      clientHeight: 40,
      clientLeft: 2,
      clientTop: 2,
      getBoundingClientRect: () => new Rect(20, 10, 22, 22),
      contentDocument: null as Document | null,
    };
    const nested = {
      defaultView: { innerWidth: 40, innerHeight: 40, frameElement: nestedFrame },
    } as unknown as Document;
    nestedFrame.contentDocument = nested;
    const element = {
      isConnected: true,
      ownerDocument: nested,
      getBoundingClientRect: () => new Rect(-10, 30, 50, 30),
    } as unknown as Element;
    expect(topViewportRect(element, top)).toEqual(new Rect(154, 114, 40, 10));
  });

  it("clips iframe selections to target and frame ancestor scrollports per axis", () => {
    const { top, frame, child, element } = fixture();
    const targetScroller = {
      ownerDocument: child,
      parentElement: null,
      offsetWidth: 50,
      offsetHeight: 50,
      clientWidth: 30,
      clientHeight: 25,
      clientLeft: 5,
      clientTop: 5,
      getBoundingClientRect: () => new Rect(0, 0, 100, 100),
    } as unknown as Element;
    Object.defineProperty(element, "parentElement", { value: targetScroller });
    element.getBoundingClientRect = () => new DOMRect(0, 20, 40, 40);

    const stage = {
      ownerDocument: top,
      parentElement: null,
      offsetWidth: 300,
      offsetHeight: 200,
      clientWidth: 280,
      clientHeight: 50,
      clientLeft: 4,
      clientTop: 3,
      getBoundingClientRect: () => new Rect(90, 80, 300, 200),
    } as unknown as Element;
    Object.defineProperty(frame, "parentElement", { value: stage });

    const childStyle = child.defaultView!.getComputedStyle;
    child.defaultView!.getComputedStyle = (candidate) =>
      candidate === targetScroller
        ? ({ overflowX: "hidden", overflowY: "visible" } as CSSStyleDeclaration)
        : childStyle(candidate);
    const topStyle = top.defaultView!.getComputedStyle;
    top.defaultView!.getComputedStyle = (candidate) =>
      candidate === stage
        ? ({ overflowX: "visible", overflowY: "auto" } as CSSStyleDeclaration)
        : topStyle(candidate);

    // The target scroller's 2x transformed client box clips x to [10, 70].
    // The stage clips y to its bordered client scrollport [83, 133].
    expect(topViewportRect(element, top)).toEqual(new Rect(132, 102, 60, 31));

    element.getBoundingClientRect = () => new DOMRect(-20, 20, 5, 10);
    expect(topViewportRect(element, top)).toEqual(new Rect(132, 102, 0, 20));
  });

  it.each([
    { position: "fixed", block: {}, clippedWidth: 60 },
    { position: "fixed", block: { transform: "matrix(1, 0, 0, 1, 0, 0)" }, clippedWidth: 40 },
    { position: "fixed", block: { translate: "0px" }, clippedWidth: 40 },
    { position: "fixed", block: { contain: "layout" }, clippedWidth: 40 },
    { position: "fixed", block: { willChange: "opacity,  transform " }, clippedWidth: 40 },
    { position: "fixed", block: { willChange: "custom-transform" }, clippedWidth: 60 },
    { position: "absolute", block: { position: "relative" }, clippedWidth: 40 },
  ])("clips $position at its containing block: $block", ({ position, block, clippedWidth }) => {
    for (const descendant of [false, true]) {
      const { top, child, element } = fixture();
      const containingBlock = {
        parentElement: null,
        offsetWidth: 30,
        offsetHeight: 100,
        clientWidth: 30,
        clientHeight: 100,
        clientLeft: 0,
        clientTop: 0,
        getBoundingClientRect: () => new Rect(0, 0, 30, 100),
      } as unknown as Element;
      const scroller = {
        ...containingBlock,
        parentElement: containingBlock,
        getBoundingClientRect: () => new Rect(70, 70, 30, 100),
      } as unknown as Element;
      const positioned = descendant ? ({ parentElement: scroller } as unknown as Element) : element;
      Object.defineProperty(element, "parentElement", {
        value: descendant ? positioned : scroller,
      });
      child.defaultView!.getComputedStyle = (candidate) =>
        ({
          ...(candidate === containingBlock ? block : {}),
          ...(candidate === scroller || candidate === containingBlock
            ? { overflowX: "hidden", overflowY: "hidden" }
            : {}),
          ...(candidate === positioned ? { position } : {}),
        }) as unknown as CSSStyleDeclaration;
      // The intermediate scroller excludes the whole target, but has no
      // containing block. The real block clips x; viewport-fixed boxes escape it.
      expect(topViewportRect(element, top)).toEqual(new Rect(132, 102, clippedWidth, 80));
    }
  });

  it("drops detached, navigated, and now-inaccessible frame documents", () => {
    const { top, frame, child, element } = fixture();
    frame.isConnected = false;
    expect(topViewportRect(element, top)).toBeNull();
    frame.isConnected = true;
    frame.contentDocument = null;
    expect(topViewportRect(element, top)).toBeNull();
    Object.defineProperty(child.defaultView, "frameElement", {
      get: () => {
        throw new Error("SecurityError");
      },
    });
    expect(topViewportRect(element, top)).toBeNull();
  });

  it("descends accessible frames using content coordinates and preserves inaccessible frame fallback", () => {
    const { top, frame, child, element } = fixture();
    top.elementsFromPoint = () => [frame as unknown as Element];
    child.elementsFromPoint = vi.fn(() => [element]);
    expect(pickInDocument(top, 142, 112, () => false)).toBe(element);
    expect(child.elementsFromPoint).toHaveBeenCalledWith(15, 25);
    frame.contentDocument = null;
    expect(pickInDocument(top, 142, 112, () => false)).toBe(frame);
    expect(frameDocument(frame as unknown as Element)).toBeNull();
  });

  it.each([
    { transform: "matrix(0, 1, -1, 0, 0, 0)" },
    { transform: "matrix(1, 0, 0.25, 1, 0, 0)" },
    { transform: "matrix(-1, 0, 0, 1, 0, 0)" },
    { transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -0.002, 0, 0, 0, 1)" },
    { perspective: "500px" },
    { rotate: "15deg" },
    { scale: "-1 1" },
  ])("falls back to the frame for unsupported transforms: %o", (unsupported) => {
    const { top, frame, child, element } = fixture();
    const originalStyle = top.defaultView!.getComputedStyle(frame as unknown as Element);
    top.defaultView!.getComputedStyle = () => ({ ...originalStyle, ...unsupported });
    top.elementsFromPoint = () => [frame as unknown as Element];
    child.elementsFromPoint = vi.fn(() => [element]);
    expect(topViewportRect(element, top)).toBeNull();
    expect(
      topViewportPoint({ target: element, clientX: 15, clientY: 25 } as unknown as MouseEvent, top),
    ).toBeNull();
    expect(pickInDocument(top, 142, 112, () => false)).toBe(frame);
    expect(child.elementsFromPoint).not.toHaveBeenCalled();
  });

  it("rejects unsupported transforms on iframe ancestors", () => {
    const { top, frame, element } = fixture();
    const ancestor = {} as Element;
    Object.defineProperty(frame, "parentElement", { value: ancestor });
    const originalStyle = top.defaultView!.getComputedStyle(frame as unknown as Element);
    top.defaultView!.getComputedStyle = (candidate) =>
      candidate === ancestor ? { ...originalStyle, rotate: "45deg" } : originalStyle;
    expect(topViewportRect(element, top)).toBeNull();
  });

  it.each([
    "matrix(2, 0, 0, 2, 10, 20)",
    "matrix3d(2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)",
  ])("retains supported axis-aligned transforms: %s", (transform) => {
    const { top, frame, element } = fixture();
    const originalStyle = top.defaultView!.getComputedStyle(frame as unknown as Element);
    top.defaultView!.getComputedStyle = () => ({ ...originalStyle, transform });
    expect(topViewportRect(element, top)).toEqual(new Rect(132, 102, 60, 80));
  });

  it("recognizes child-realm elements without top-window instanceof checks", () => {
    const { element } = fixture();
    expect(isElement(element)).toBe(true);
    expect(hasInlineStyle(element)).toBe(true);
    expect(isElement(null)).toBe(false);
    expect(isElement({ nodeType: 3 })).toBe(false);
  });
});

function observerFixture() {
  const callbacks = new Map<Document, MutationCallback>();
  class Observer {
    callback: MutationCallback;
    constructor(callback: MutationCallback) {
      this.callback = callback;
    }
    observe(owner: Document) {
      callbacks.set(owner, this.callback);
    }
    disconnect() {}
  }
  vi.stubGlobal("MutationObserver", Observer);
  const frameList: HTMLIFrameElement[] = [];
  const queryFrames = vi.fn(() => frameList);
  const top = { querySelectorAll: queryFrames } as unknown as Document;
  const child = { querySelectorAll: vi.fn(() => []) } as unknown as Document;
  const frame = Object.assign(new EventTarget(), {
    nodeType: 1,
    localName: "iframe",
    contentDocument: child,
  }) as unknown as HTMLIFrameElement;
  const unrelated = {
    nodeType: 1,
    localName: "div",
    querySelector: vi.fn(() => null),
  } as unknown as Element;
  const lifecycle: string[] = [];
  const attach = vi.fn((owner: Document) => {
    lifecycle.push(owner === top ? "attach top" : "attach child");
    return () => lifecycle.push(owner === top ? "remove top" : "remove child");
  });
  const changed = vi.fn();
  const watch = observeFrameDocuments(top, attach, changed, () => false);
  const mutate = (record: Partial<MutationRecord>) =>
    callbacks.get(top)!(
      [
        {
          target: unrelated,
          addedNodes: [],
          removedNodes: [],
          ...record,
        } as unknown as MutationRecord,
      ],
      {} as MutationObserver,
    );
  return {
    frameList,
    queryFrames,
    top,
    child,
    frame,
    unrelated,
    lifecycle,
    attach,
    changed,
    watch,
    mutate,
  };
}

describe("frame document observation", () => {
  it("does not rescan documents for animated attributes or unrelated text changes", async () => {
    const fixture = observerFixture();
    for (let index = 0; index < 60; index += 1) {
      fixture.mutate({ type: "attributes", attributeName: "style" });
      fixture.mutate({ type: "attributes", attributeName: "class" });
      fixture.mutate({ type: "childList", addedNodes: [{ nodeType: 3 }] as unknown as NodeList });
      await Promise.resolve();
    }
    expect(fixture.queryFrames).toHaveBeenCalledTimes(1);
    expect(fixture.attach).toHaveBeenCalledTimes(1);
    expect(fixture.changed).toHaveBeenCalledTimes(60);
    expect(fixture.unrelated.querySelector).not.toHaveBeenCalled();
    fixture.watch.dispose();
  });

  it("batches frame-containing subtree insertion and removes old document listeners", async () => {
    const fixture = observerFixture();
    fixture.frameList.push(fixture.frame);
    const subtree = {
      nodeType: 1,
      localName: "section",
      querySelector: () => fixture.frame,
    } as unknown as Node;
    fixture.mutate({ type: "childList", addedNodes: [subtree] as unknown as NodeList });
    fixture.mutate({ type: "childList", addedNodes: [fixture.frame] as unknown as NodeList });
    await Promise.resolve();
    expect(fixture.queryFrames).toHaveBeenCalledTimes(2);
    expect(fixture.watch.documents()).toEqual([fixture.top, fixture.child]);
    expect(fixture.changed).toHaveBeenCalledTimes(1);
    fixture.frameList.length = 0;
    fixture.mutate({ type: "childList", removedNodes: [subtree] as unknown as NodeList });
    await Promise.resolve();
    expect(fixture.queryFrames).toHaveBeenCalledTimes(3);
    expect(fixture.watch.documents()).toEqual([fixture.top]);
    expect(fixture.lifecycle).toEqual(["attach top", "attach child", "remove child"]);
    fixture.watch.dispose();
  });

  it("cleans the replaced document before attaching its successor on frame load", async () => {
    const fixture = observerFixture();
    fixture.frameList.push(fixture.frame);
    fixture.mutate({ type: "childList", addedNodes: [fixture.frame] as unknown as NodeList });
    await Promise.resolve();
    const successor = { querySelectorAll: () => [] } as unknown as Document;
    Object.assign(fixture.frame, { contentDocument: successor });
    fixture.frame.dispatchEvent(new Event("load"));
    fixture.frame.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(fixture.queryFrames).toHaveBeenCalledTimes(3);
    expect(fixture.watch.documents()).toEqual([fixture.top, successor]);
    expect(fixture.lifecycle).toEqual([
      "attach top",
      "attach child",
      "remove child",
      "attach child",
    ]);
    fixture.watch.dispose();
    fixture.frame.dispatchEvent(new Event("load"));
    await Promise.resolve();
    expect(fixture.queryFrames).toHaveBeenCalledTimes(3);
  });

  it("discards queued work after the annotation session is disposed", async () => {
    const fixture = observerFixture();
    fixture.mutate({ type: "childList", addedNodes: [fixture.frame] as unknown as NodeList });
    fixture.watch.dispose();
    await Promise.resolve();
    expect(fixture.queryFrames).toHaveBeenCalledTimes(1);
    expect(fixture.changed).not.toHaveBeenCalled();
  });
});
