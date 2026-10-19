import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import "../index.css";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import { TooltipProvider } from "./ui/tooltip";

it("keeps the status dot the same visible size when the label is compacted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const status = {
    colorClass: "text-sky-600",
    dotClass: "bg-sky-500",
    label: "Working",
    pulse: false,
  };
  try {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <div data-status="expanded">
            <ThreadStatusLabel status={status} />
          </div>
          <div data-status="compact">
            <ThreadStatusLabel status={status} compact />
          </div>
        </TooltipProvider>,
      );
    });
    const expanded = container.querySelector<HTMLElement>('[data-status="expanded"] .rounded-full');
    const compact = container.querySelector<HTMLElement>('[data-status="compact"] .rounded-full');
    if (!expanded || !compact) throw new Error("Both status labels must show a dot.");
    const expandedSize = expanded.getBoundingClientRect();
    const compactSize = compact.getBoundingClientRect();
    expect(expandedSize.width).toBeGreaterThan(0);
    expect(compactSize.width).toBe(expandedSize.width);
    expect(compactSize.height).toBe(expandedSize.height);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
