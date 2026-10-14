import { useCallback, useRef } from "react";
import { autoAnimate } from "@formkit/auto-animate";
const OPTIONS = { duration: 180, easing: "ease-out" } as const;
/** Attach each concrete list once across renders; remounted lists receive their own animation. */
export function useLastCodeSidebarListAnimation() {
  const animatedLists = useRef(new WeakSet<HTMLElement>());
  return useCallback((node: HTMLElement | null) => {
    if (!node || animatedLists.current.has(node)) return;
    autoAnimate(node, OPTIONS);
    animatedLists.current.add(node);
  }, []);
}
