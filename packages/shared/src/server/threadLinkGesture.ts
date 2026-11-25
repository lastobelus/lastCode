import { parseThreadLinkHref, THREAD_LINK_PROTOCOL } from "../threadLinks.ts";

type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export function matchesThreadLinkPopup(announced: string | undefined, url: string) {
  return (
    announced !== undefined &&
    (announced === url ||
      (announced.startsWith(`${THREAD_LINK_PROTOCOL}:`) && [":", "", "about:blank"].includes(url)))
  );
}

export function createBrowserThreadLinkNavigation(
  open: (href: string, kind: "navigation" | "window") => void,
  world = "t3-thread-link-activation",
  declined: (href: string, kind: "navigation" | "window") => void = () => {},
) {
  let mainFrameId: string | undefined;
  let scriptId: string | undefined;
  const activeFrames = new Set<string>();
  const contexts = new Map<number, string>();
  return {
    get active() {
      return activeFrames.size > 0;
    },
    async install(command: Send) {
      const send = command;
      const tree = (await send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      mainFrameId = tree.frameTree.frame.id;
      await send("Runtime.enable");
      await send("Runtime.addBinding", {
        name: "t3ThreadLinkGesture",
        executionContextName: world,
      });
      await send("Page.enable");
      // External protocols consume activation before the navigation event reaches the host.
      if (scriptId)
        await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
      const script = await send("Page.addScriptToEvaluateOnNewDocument", {
        worldName: world,
        runImmediately: true,
        source: `if (!globalThis.t3ThreadLinkGestureInstalled) {
        globalThis.t3ThreadLinkGestureInstalled = true;
        for (const name of ["click", "auxclick", "keydown"]) {
          addEventListener(name, (event) => {
            if (!event.isTrusted || !navigator.userActivation.isActive) return;
            t3ThreadLinkGesture("active");
            setTimeout(() => t3ThreadLinkGesture("inactive"), 0);
          }, true);
        }}`,
      });
      scriptId = (script as { identifier?: string }).identifier;
    },
    receive(method: string, params: unknown) {
      if (method === "Runtime.executionContextsCleared") {
        contexts.clear();
        activeFrames.clear();
      } else if (method === "Runtime.executionContextCreated") {
        const { context } = params as {
          context: { name: string; id: number; auxData?: { frameId?: string } };
        };
        if (context.name === world && context.auxData?.frameId)
          contexts.set(context.id, context.auxData.frameId);
      } else if (method === "Runtime.executionContextDestroyed") {
        const { executionContextId } = params as { executionContextId: number };
        const frameId = contexts.get(executionContextId);
        if (frameId) activeFrames.delete(frameId);
        contexts.delete(executionContextId);
      } else if (method === "Runtime.bindingCalled") {
        const { name, payload, executionContextId } = params as {
          name: string;
          payload: string;
          executionContextId: number;
        };
        const frameId = contexts.get(executionContextId);
        if (name !== "t3ThreadLinkGesture" || frameId === undefined) return;
        if (payload === "active") activeFrames.add(frameId);
        else activeFrames.delete(frameId);
      } else if (method === "Page.windowOpen") {
        const { url, userGesture } = params as { url: string; userGesture: boolean };
        if (!parseThreadLinkHref(url)) return;
        if (userGesture && activeFrames.size > 0) open(url, "window");
        else declined(url, "window");
      } else if (method === "Page.frameRequestedNavigation") {
        const { frameId, disposition, url } = params as {
          frameId: string;
          disposition: string;
          url: string;
        };
        if (frameId !== mainFrameId || disposition !== "currentTab" || !parseThreadLinkHref(url))
          return;
        if (activeFrames.size > 0) open(url, "navigation");
        else declined(url, "navigation");
      }
    },
  };
}
