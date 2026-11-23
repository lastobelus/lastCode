// @effect-diagnostics nodeBuiltinImport:off -- Native host filesystem fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readFullCiStamp, resolveFullCiStampPath } from "./lastcode-local-ci.ts";

describe("full CI stamp reader", () => {
  it("preserves native JSON validation, incidental fields, and context shapes", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "stamp-reader-"));
    const path = resolveFullCiStampPath(root, "head");
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    try {
      expect(readFullCiStamp(root, "head")).toBeUndefined();
      const fields = { schemaVersion: 2, commit: "head", context: {}, completedAt: "" };
      for (const context of [{}, [], { kind: "unknown" }]) {
        const value = { extra: [1], ...fields, context };
        NodeFS.writeFileSync(path, JSON.stringify(value));
        const result = readFullCiStamp(root, "head");
        expect(result).toEqual(value);
        expect(Object.keys(result!)).toEqual(Object.keys(value));
      }
      for (const value of [
        {},
        [],
        true,
        3,
        "root",
        { ...fields, schemaVersion: "2" },
        { ...fields, schemaVersion: 1 },
        { ...fields, commit: "other" },
        { ...fields, context: null },
        { ...fields, context: "context" },
        { ...fields, completedAt: null },
        { ...fields, completedAt: 2 },
      ]) {
        NodeFS.writeFileSync(path, JSON.stringify(value));
        expect(() => readFullCiStamp(root, "head")).toThrow(
          `Invalid LastCode CI stamp at ${path}.`,
        );
      }
      NodeFS.writeFileSync(path, "null");
      expect(() => readFullCiStamp(root, "head")).toThrow(TypeError);
      for (const json of ["", "{", '{"schemaVersion":2,}', "[1,,2]"]) {
        NodeFS.writeFileSync(path, json);
        expect(() => readFullCiStamp(root, "head")).toThrow(SyntaxError);
      }
      NodeFS.writeFileSync(path, Buffer.from([0xff]));
      expect(() => readFullCiStamp(root, "head")).toThrow(SyntaxError);
      NodeFS.writeFileSync(
        path,
        Buffer.concat([
          Buffer.from('{"schemaVersion":2,"commit":"head","context":{},"completedAt":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
      );
      expect(readFullCiStamp(root, "head")?.completedAt).toBe("\ufffd");
      NodeFS.rmSync(path);
      NodeFS.mkdirSync(path);
      expect(() => readFullCiStamp(root, "head")).toThrow(/EISDIR/);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
