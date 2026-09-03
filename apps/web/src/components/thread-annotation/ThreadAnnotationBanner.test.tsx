import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack } from "../chat/ComposerBannerStack";
import { threadAnnotationBannerPresentation } from "./ThreadAnnotation";

describe("threadAnnotationBannerPresentation", () => {
  it("keeps rich annotation content below the compact summary row", () => {
    const markup = renderToStaticMarkup(
      <ComposerBannerStack
        items={[
          {
            id: "thread-annotation:test",
            variant: "warning",
            icon: <span>!</span>,
            ...threadAnnotationBannerPresentation({
              annotation: {
                anchorMessageId: MessageId.make("annotation-anchor"),
                body: "# Follow up\n\nLong annotation text",
                createdAt: "2026-09-03T00:00:00.000Z",
                resolvedAt: null,
                updatedAt: "2026-09-03T00:00:00.000Z",
              },
              onBodyChange: vi.fn(async () => true),
              threadRef: scopeThreadRef(
                EnvironmentId.make("annotation-environment"),
                ThreadId.make("annotation-thread"),
              ),
            }),
          },
        ]}
      />,
    );

    expect(markup).toContain("NOTE:");
    expect(markup).toContain("Edited");
    expect(markup.indexOf('data-composer-banner-row="true"')).toBeLessThan(
      markup.indexOf('data-slot="scroll-area-viewport"'),
    );
    expect(markup).toContain("Long annotation text");
    expect(markup).not.toContain("max-h-48 overflow-y-auto");
  });
});
