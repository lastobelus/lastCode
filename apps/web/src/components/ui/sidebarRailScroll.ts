/** The resize rail overlaps the list edge but is outside its native scroll ancestry. */
export function bindSidebarRailScroll(rail: HTMLElement) {
  const handleWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
    const contents = rail
      .closest("[data-slot='sidebar-inner']")
      ?.querySelectorAll("[data-sidebar='content']");
    // Activity retains previously visited sidebars with zero rendered bounds.
    // Resolve on each wheel event so mode switches need no listener rebinding.
    const viewport = Array.from(contents ?? [], (content) =>
      content.closest<HTMLElement>("[data-slot='scroll-area-viewport']"),
    ).find((candidate) => {
      if (!candidate) return false;
      const bounds = candidate.getBoundingClientRect();
      return bounds.bottom > bounds.top;
    });
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
