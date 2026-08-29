import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ThreadAnnotationPostIt } from "./ThreadAnnotation";

describe("ThreadAnnotationPostIt", () => {
  it("layers the warning tint over the shared readable overlay surface", () => {
    const markup = renderToStaticMarkup(
      <ThreadAnnotationPostIt
        annotation={{
          anchorMessageId: MessageId.make("annotation-anchor"),
          body: "# Follow up\n\nLong annotation text",
          createdAt: "2026-08-28T00:00:00.000Z",
          resolvedAt: null,
          updatedAt: "2026-08-28T00:00:00.000Z",
        }}
        onBodyChange={async () => true}
        onDismiss={vi.fn()}
        onEdit={vi.fn()}
        onResolve={vi.fn()}
        threadRef={{
          environmentId: EnvironmentId.make("annotation-environment"),
          threadId: ThreadId.make("annotation-thread"),
        }}
      />,
    );

    const outerClasses = markup.match(/^<div class="([^"]+)"/)?.[1];
    expect(markup).toContain("dropdown-glass");
    expect(markup).toContain("overflow-hidden");
    expect(markup).toContain("bg-warning/10");
    expect(outerClasses).not.toContain("shadow");
    expect(markup.indexOf("dropdown-glass")).toBeLessThan(markup.indexOf("bg-warning/10"));
  });
});
