/** DOM helpers shared by the top-level annotation preload and accessible child documents. */
export function isElement(value: unknown): value is Element {
  return typeof value === "object" && value !== null && "nodeType" in value && value.nodeType === 1;
}

export function hasInlineStyle(element: Element): element is HTMLElement | SVGElement {
  return "style" in element;
}

export function frameDocument(element: Element): Document | null {
  if (element.localName !== "iframe") return null;
  try {
    return (element as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

function owningFrame(owner: Document): HTMLIFrameElement | null {
  try {
    const frame = owner.defaultView?.frameElement;
    return frame?.isConnected && frameDocument(frame) === owner
      ? (frame as HTMLIFrameElement)
      : null;
  } catch {
    // A retained document may already have navigated to an inaccessible origin.
    return null;
  }
}

/** Rect-based conversion supports positive axis-aligned scaling and translation only. */
function hasSupportedTransform(style: CSSStyleDeclaration): boolean {
  if (style.perspective && style.perspective !== "none") return false;
  if (style.rotate && style.rotate !== "none" && style.rotate !== "0deg") return false;
  if (
    style.scale &&
    style.scale !== "none" &&
    style.scale.split(/\s+/).some((value) => !(Number.parseFloat(value) > 0))
  )
    return false;
  if (!style.transform || style.transform === "none") return true;
  const match = /^(matrix|matrix3d)\(([^)]+)\)$/.exec(style.transform);
  if (!match) return false;
  const values = match[2]!.split(",").map(Number);
  if (values.some((value) => !Number.isFinite(value))) return false;
  if (match[1] === "matrix") {
    return (
      values.length === 6 && values[0]! > 0 && values[3]! > 0 && values[1] === 0 && values[2] === 0
    );
  }
  return (
    values.length === 16 &&
    values[0]! > 0 &&
    values[5]! > 0 &&
    values[10]! > 0 &&
    values[15] === 1 &&
    [1, 2, 3, 4, 6, 7, 8, 9, 11].every((index) => values[index] === 0)
  );
}

function frameGeometry(frame: HTMLIFrameElement) {
  const view = frame.ownerDocument.defaultView;
  if (!view) return null;
  for (let ancestor: Element | null = frame; ancestor; ancestor = ancestor.parentElement) {
    if (!hasSupportedTransform(view.getComputedStyle(ancestor))) return null;
  }
  const bounds = frame.getBoundingClientRect();
  const style = view.getComputedStyle(frame);
  const scaleX = frame.offsetWidth ? bounds.width / frame.offsetWidth : 0;
  const scaleY = frame.offsetHeight ? bounds.height / frame.offsetHeight : 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const width = frame.clientWidth - paddingLeft - (Number.parseFloat(style.paddingRight) || 0);
  const height = frame.clientHeight - paddingTop - (Number.parseFloat(style.paddingBottom) || 0);
  return {
    x: bounds.left + (frame.clientLeft + paddingLeft) * scaleX,
    y: bounds.top + (frame.clientTop + paddingTop) * scaleY,
    width: Math.max(0, width) * scaleX,
    height: Math.max(0, height) * scaleY,
    scaleX,
    scaleY,
  };
}

function intersect(rect: DOMRect, clip: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(rect.x, clip.x);
  const y = Math.max(rect.y, clip.y);
  return new DOMRect(
    x,
    y,
    Math.max(0, Math.min(rect.right, clip.x + clip.width) - x),
    Math.max(0, Math.min(rect.bottom, clip.y + clip.height) - y),
  );
}

/** Converts a child viewport rect through each frame's content box, clipping at every viewport. */
export function topViewportRect(
  element: Element,
  topDocument: Document = document,
): DOMRect | null {
  if (!element.isConnected) return null;
  let owner = element.ownerDocument;
  let rect = element.getBoundingClientRect();
  while (owner !== topDocument) {
    const view = owner.defaultView;
    const frame = owningFrame(owner);
    if (!view || !frame) return null;
    rect = intersect(rect, { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight });
    const geometry = frameGeometry(frame);
    if (!geometry) return null;
    rect = intersect(
      new DOMRect(
        geometry.x + rect.x * geometry.scaleX,
        geometry.y + rect.y * geometry.scaleY,
        rect.width * geometry.scaleX,
        rect.height * geometry.scaleY,
      ),
      geometry,
    );
    owner = frame.ownerDocument;
  }
  const view = topDocument.defaultView;
  return view
    ? intersect(rect, { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight })
    : null;
}

export function topViewportPoint(event: MouseEvent, topDocument: Document = document) {
  let owner = isElement(event.target) ? event.target.ownerDocument : topDocument;
  let x = event.clientX;
  let y = event.clientY;
  while (owner !== topDocument) {
    const frame = owningFrame(owner);
    if (!frame) return null;
    const geometry = frameGeometry(frame);
    if (!geometry) return null;
    x = geometry.x + x * geometry.scaleX;
    y = geometry.y + y * geometry.scaleY;
    owner = frame.ownerDocument;
  }
  return { x, y };
}

export function pickInDocument(
  owner: Document,
  x: number,
  y: number,
  ignore: (element: Element) => boolean,
): Element | null {
  for (const candidate of owner.elementsFromPoint(x, y)) {
    if (ignore(candidate) || candidate === owner.documentElement || candidate === owner.body)
      continue;
    const child = frameDocument(candidate);
    if (child) {
      const geometry = frameGeometry(candidate as HTMLIFrameElement);
      if (
        geometry &&
        geometry.scaleX > 0 &&
        geometry.scaleY > 0 &&
        x >= geometry.x &&
        y >= geometry.y &&
        x < geometry.x + geometry.width &&
        y < geometry.y + geometry.height
      ) {
        const picked = pickInDocument(
          child,
          (x - geometry.x) / geometry.scaleX,
          (y - geometry.y) / geometry.scaleY,
          ignore,
        );
        if (picked) return picked;
      }
    }
    return candidate;
  }
  return null;
}

/** Tracks frame loads and DOM replacement without enabling preloads or Node in subframes. */
export function observeFrameDocuments(
  topDocument: Document,
  attach: (owner: Document) => () => void,
  changed: () => void,
  ignore: (element: Element) => boolean,
) {
  const documents = new Map<Document, () => void>();
  const frames = new Map<HTMLIFrameElement, () => void>();
  let disposed = false;
  const refresh = (notify = true) => {
    if (disposed) return;
    const foundDocuments = new Set<Document>();
    const foundFrames = new Set<HTMLIFrameElement>();
    const visit = (owner: Document) => {
      foundDocuments.add(owner);
      for (const frame of owner.querySelectorAll("iframe")) {
        foundFrames.add(frame);
        const child = frameDocument(frame);
        if (child) visit(child);
      }
    };
    visit(topDocument);
    for (const [owner, cleanup] of documents) {
      if (!foundDocuments.has(owner)) {
        cleanup();
        documents.delete(owner);
      }
    }
    for (const [frame, cleanup] of frames) {
      if (!foundFrames.has(frame)) {
        cleanup();
        frames.delete(frame);
      }
    }
    // Initial about:blank and srcdoc documents can share a Window. Remove the
    // old document's listeners before adding the same callbacks to its successor.
    for (const owner of foundDocuments) {
      if (!documents.has(owner)) {
        const cleanup = attach(owner);
        const observer = new MutationObserver((records) => {
          if (records.some((record) => !isElement(record.target) || !ignore(record.target)))
            refresh();
        });
        observer.observe(owner, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden", "width", "height"],
        });
        documents.set(owner, () => {
          observer.disconnect();
          cleanup();
        });
      }
    }
    for (const frame of foundFrames) {
      if (!frames.has(frame)) {
        const loaded = () => refresh();
        frame.addEventListener("load", loaded);
        frames.set(frame, () => frame.removeEventListener("load", loaded));
      }
    }
    if (notify) changed();
  };
  refresh(false);
  return {
    documents: () => Array.from(documents.keys()),
    dispose: () => {
      disposed = true;
      for (const cleanup of documents.values()) cleanup();
      for (const cleanup of frames.values()) cleanup();
      documents.clear();
      frames.clear();
    },
  };
}
