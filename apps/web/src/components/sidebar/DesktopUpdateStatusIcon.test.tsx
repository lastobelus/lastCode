import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DesktopUpdateStatusIcon } from "./DesktopUpdateStatusIcon";

describe("DesktopUpdateStatusIcon", () => {
  it("gives the integrated activity ring one bounded spin when progress is unknown", () => {
    const markup = renderToStaticMarkup(
      <DesktopUpdateStatusIcon downloadPercent={null} status="downloading" />,
    );

    expect(markup).toContain("animate-[spin_700ms_ease-out_1]");
    expect(markup).not.toContain("animate-spin");
    expect(markup).toContain("motion-reduce:animate-none");
  });

  it("shows determinate progress without spinning the ring", () => {
    const markup = renderToStaticMarkup(
      <DesktopUpdateStatusIcon downloadPercent={50} status="downloading" />,
    );

    expect(markup).not.toContain("animate-spin");
    expect(markup).toContain("transition-[stroke-dashoffset]");
  });
});
