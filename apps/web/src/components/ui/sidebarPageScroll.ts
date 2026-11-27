/** Mouse utilities can emit page keys; keep their target under the pointer without taking focus. */
export function bindSidebarPageScroll(scrollArea: HTMLElement) {
  const viewport = scrollArea.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']");
  if (!viewport) return;
  const document = scrollArea.ownerDocument;
  const window = document.defaultView;
  const sidebar =
    scrollArea.closest("[data-slot='sidebar-inner'],[data-slot='sidebar']") ?? scrollArea;
  let pointer: { x: number; y: number } | null = null;

  const clearPointer = () => {
    pointer = null;
  };
  const handlePointerMove = (event: PointerEvent) => {
    pointer = event.pointerType === "mouse" ? { x: event.clientX, y: event.clientY } : null;
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (
      !pointer ||
      (event.key !== "PageUp" && event.key !== "PageDown") ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      viewport.scrollHeight <= viewport.clientHeight
    )
      return;

    const bounds = viewport.getBoundingClientRect();
    if (pointer.y < bounds.top || pointer.y >= bounds.bottom) return;
    const hovered = document.elementFromPoint(pointer.x, pointer.y);
    const rail = scrollArea
      .closest("[data-slot='sidebar-inner']")
      ?.querySelector("[data-sidebar='rail']");
    if (!hovered || (!viewport.contains(hovered) && !rail?.contains(hovered))) return;
    const target = event.target instanceof Element ? event.target : null;
    const floatingLayer = target?.closest(
      "[role='dialog'],[role='alertdialog'],[role='menu'],[role='listbox']",
    );
    if (floatingLayer && !floatingLayer.contains(viewport)) return;
    if (target?.closest("[aria-activedescendant],[role='combobox'][aria-expanded='true']")) return;
    if (
      target &&
      sidebar.contains(target) &&
      target.closest("input,textarea,select,[contenteditable],[role='textbox']")
    )
      return;

    event.preventDefault();
    event.stopPropagation();
    viewport.scrollBy({
      top: (event.key === "PageDown" ? 1 : -1) * viewport.clientHeight * 0.9,
      behavior: "instant",
    });
  };
  document.addEventListener("pointermove", handlePointerMove, { passive: true });
  document.addEventListener("pointerleave", clearPointer);
  document.addEventListener("keydown", handleKeyDown, true);
  window?.addEventListener("blur", clearPointer);
  return () => {
    document.removeEventListener("pointermove", handlePointerMove);
    document.removeEventListener("pointerleave", clearPointer);
    document.removeEventListener("keydown", handleKeyDown, true);
    window?.removeEventListener("blur", clearPointer);
  };
}
