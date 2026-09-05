import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  frameDocument,
  hasInlineStyle,
  isElement,
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
