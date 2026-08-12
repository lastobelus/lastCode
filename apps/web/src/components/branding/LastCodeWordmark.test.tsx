import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LastCodeWordmark } from "./LastCodeWordmark";

describe("LastCodeWordmark", () => {
  it("themes Last and Code independently", () => {
    const markup = renderToStaticMarkup(<LastCodeWordmark />);

    expect(markup).toContain('aria-label="LastCode"');
    expect(markup).toContain('data-wordmark-part="last"');
    expect(markup).toContain("text-sidebar-foreground");
    expect(markup).toContain('data-wordmark-part="code"');
    expect(markup).toContain("text-sidebar-muted-foreground");
    expect(markup.match(/<path/g)).toHaveLength(8);
    expect(markup).not.toContain("#999");
  });

  it("uses backdrop-safe colors over stage artwork", () => {
    const markup = renderToStaticMarkup(<LastCodeWordmark onBackdrop />);

    expect(markup).toContain('class="text-white"');
    expect(markup).toContain('class="text-white/70"');
  });
});
