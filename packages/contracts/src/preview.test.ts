import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewEvent, PreviewOpenInput } from "./preview.ts";

import { PreviewAutomationHost, PreviewAutomationStatus } from "./previewAutomation.ts";

const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});

const decodePreviewEvent = Schema.decodeUnknownSync(PreviewEvent);
const decodePreviewOpenInput = Schema.decodeUnknownSync(PreviewOpenInput);

describe("PreviewEvent focus", () => {
  it("retains background focus intent independently of visibility through the wire schemas", () => {
    const request = decodePreviewOpenInput({
      threadId: "t",
      runtime: "server",
      background: true,
    });
    expect(request.background).toBe(true);
    expect(request.reveal).toBeUndefined();
    const event = decodePreviewEvent({
      type: "opened",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      background: request.background,
      snapshot: {
        threadId: "t",
        tabId: "preview-t",
        runtime: "server",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(event.type).toBe("opened");
    if (event.type === "opened") {
      expect(event.background).toBe(true);
      expect(event.snapshot.reveal).toBeUndefined();
    }
  });

  it("carries originating selection through creation and rejects invalid revisions", () => {
    const focus = { clientId: "origin-client", userActionRevision: 7 };
    const request = decodePreviewOpenInput({ threadId: "t", focus });
    const event = decodePreviewEvent({
      type: "opened",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "now",
      serverEpoch: "server-a",
      revision: 1,
      focus: request.focus,
      snapshot: {
        threadId: "t",
        tabId: "preview-t",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "now",
      },
    });
    expect(event).toMatchObject({ type: "opened", focus });
    for (const invalid of [
      { ...focus, clientId: " " },
      { ...focus, userActionRevision: -1 },
      { ...focus, userActionRevision: 0.5 },
    ]) {
      expect(() => decodePreviewOpenInput({ threadId: "t", focus: invalid })).toThrow();
    }
  });
});
