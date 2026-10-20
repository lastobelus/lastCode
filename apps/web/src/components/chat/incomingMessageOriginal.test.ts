import { describe, expect, it } from "vite-plus/test";
import { formatIncomingMessageOriginal } from "./incomingMessageOriginal";

describe("opened incoming originals", () => {
  it("passes valid objects and arrays to the existing JSON code renderer", () => {
    expect(formatIncomingMessageOriginal('{"task":"inspect","allowed":["repair"]}')).toBe(
      '```json\n{\n  "task": "inspect",\n  "allowed": [\n    "repair"\n  ]\n}\n```',
    );
    expect(formatIncomingMessageOriginal('["inspect", "repair"]')).toBe(
      '```json\n[\n  "inspect",\n  "repair"\n]\n```',
    );
  });

  it("keeps prose, partial JSON, and existing Markdown verbatim", () => {
    for (const text of [
      "Continue the task.",
      '{"task":',
      "[See the result](https://example.com)",
      '```json\n{"task":"inspect"}\n```',
    ]) {
      expect(formatIncomingMessageOriginal(text)).toBe(text);
    }
  });
});
