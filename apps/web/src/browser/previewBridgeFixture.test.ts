import { describe, expect, it } from "vite-plus/test";

import { createPreviewBridgeFixture } from "../../test/previewBridge";

describe("preview bridge fixture", () => {
  it("keeps explicit implementations and rejects unstubbed calls by name", async () => {
    const created: string[] = [];
    const bridge = createPreviewBridgeFixture({
      createTab: async (tabId) => {
        created.push(tabId);
      },
    });
    await bridge.createTab("test-tab");
    expect(created).toEqual(["test-tab"]);
    expect(() => bridge.navigate("test-tab", "https://example.test")).toThrow(
      "Unexpected preview bridge call: preview.navigate",
    );
    expect(() => bridge.recording.startScreencast("test-tab")).toThrow(
      "Unexpected preview bridge call: preview.recording.startScreencast",
    );
  });

  it("rejects newly added methods without adding them to an exhaustive fake", () => {
    // Model an unrelated bridge addition without changing the production contract.
    const bridge = createPreviewBridgeFixture({}) as ReturnType<
      typeof createPreviewBridgeFixture
    > & { futureOperation(): void };
    expect(() => bridge.futureOperation()).toThrow(
      "Unexpected preview bridge call: preview.futureOperation",
    );
  });
});
