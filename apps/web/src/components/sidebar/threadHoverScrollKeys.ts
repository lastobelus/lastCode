/** Mouse utilities send keys to the focused composer even while its pointer is over a hover card. */
export function bindThreadHoverScrollKeys(scrollArea: HTMLDivElement | null) {
  if (!scrollArea) return;
  const document = scrollArea.ownerDocument;
  const handleKeyDown = (event: KeyboardEvent) => {
    const page = event.key === "PageUp" || event.key === "PageDown";
    if (
      (!page && event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      scrollArea.clientHeight === 0
    )
      return;

    const target = event.target instanceof Element ? event.target : null;
    const focusedInside = target !== null && scrollArea.contains(target);
    if (!focusedInside && !scrollArea.matches(":hover")) return;
    const floatingLayer = target?.closest(
      "[role='dialog'],[role='alertdialog'],[role='menu'],[role='listbox']",
    );
    if (floatingLayer && !floatingLayer.contains(scrollArea)) return;
    if (target?.closest("[aria-activedescendant],[role='combobox'][aria-expanded='true']")) return;
    if (
      target?.closest("input,textarea,select,[contenteditable],[role='textbox']") &&
      (focusedInside || floatingLayer || target.closest("[data-slot='sidebar']"))
    )
      return;

    event.preventDefault();
    event.stopPropagation();
    const style = getComputedStyle(scrollArea);
    const distance = page
      ? scrollArea.clientHeight * 0.9
      : Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5 || 16;
    scrollArea.scrollBy({
      top: (event.key === "PageDown" || event.key === "ArrowDown" ? 1 : -1) * distance,
      behavior: "instant",
    });
  };
  document.addEventListener("keydown", handleKeyDown, true);
  return () => document.removeEventListener("keydown", handleKeyDown, true);
}
