/** The resize rail overlaps the list edge but is outside its native scroll ancestry. */
export function bindSidebarRailScroll(rail: HTMLElement) {
  const handleWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
    const viewport = rail
      .closest("[data-slot='sidebar-inner']")
      ?.querySelector("[data-sidebar='content']")
      ?.closest<HTMLElement>("[data-slot='scroll-area-viewport']");
    if (!viewport || viewport.scrollHeight <= viewport.clientHeight) return;
    const bounds = viewport.getBoundingClientRect();
    if (event.clientY < bounds.top || event.clientY >= bounds.bottom) return;

    const style = getComputedStyle(viewport);
    const lineHeight =
      Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) || 16;
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? lineHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientHeight
          : 1;
    event.preventDefault();
    viewport.scrollBy({ top: event.deltaY * unit, behavior: "instant" });
  };
  rail.addEventListener("wheel", handleWheel, { passive: false });
  return () => rail.removeEventListener("wheel", handleWheel);
}
