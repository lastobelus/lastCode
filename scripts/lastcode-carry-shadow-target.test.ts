import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { carrySetShadowTarget } from "./lastcode-carry-set.ts";

const metadata = "Upstream-Commit: base\nLastCode-Commit: source";

function expectError(contents: string, message: string, taggedCommit = "source") {
  NodeAssert.throws(() => carrySetShadowTarget("tag", contents, taggedCommit), {
    name: "Error",
    message,
  });
}

NodeTest.describe("immutable carry shadow metadata", () => {
  NodeTest.it("preserves omitted and exact accepted modes and ordered public keys", () => {
    for (const replayMode of [undefined, "carry", "historical"] as const) {
      const contents = metadata + (replayMode === undefined ? "" : `\nReplay-Mode: ${replayMode}`);
      const result = carrySetShadowTarget("tag", contents, "source");
      NodeAssert.deepEqual(result, {
        checkpointTag: "tag",
        baseCommit: "base",
        sourceCommit: "source",
        ...(replayMode === undefined ? {} : { replayMode }),
      });
      NodeAssert.deepEqual(Object.keys(result), [
        "checkpointTag",
        "baseCommit",
        "sourceCommit",
        ...(replayMode === undefined ? [] : ["replayMode"]),
      ]);
    }
  });

  NodeTest.it("uses LF or CRLF and the first exact separator without normalization", () => {
    for (const newline of ["\n", "\r\n"]) {
      const contents = [
        "ignored",
        ": ignored",
        "Upstream-Commit:base",
        "upstream-commit: ignored",
        "Upstream-Commit: base: suffix",
        "LastCode-Commit: source: suffix",
        "Replay-Mode: historical",
      ].join(newline);
      NodeAssert.deepEqual(carrySetShadowTarget("tag", contents, "source: suffix"), {
        checkpointTag: "tag",
        baseCommit: "base: suffix",
        sourceCommit: "source: suffix",
        replayMode: "historical",
      });
    }
  });

  NodeTest.it("uses the last trailer including empty and invalid duplicates", () => {
    NodeAssert.deepEqual(
      carrySetShadowTarget(
        "tag",
        `Upstream-Commit: old\nLastCode-Commit: old\nReplay-Mode: invalid\n${metadata}\nReplay-Mode: carry`,
        "source",
      ),
      { checkpointTag: "tag", baseCommit: "base", sourceCommit: "source", replayMode: "carry" },
    );
    expectError(`${metadata}\nUpstream-Commit: `, "tag is missing immutable carry-set metadata.");
    expectError(`${metadata}\nLastCode-Commit: `, "tag is missing immutable carry-set metadata.");
    expectError(
      `${metadata}\nReplay-Mode: carry\nReplay-Mode: `,
      "tag has an invalid Replay-Mode.",
    );
  });

  NodeTest.it(
    "rejects missing or empty metadata before source mismatch and mode validation",
    () => {
      for (const contents of [
        "",
        "Upstream-Commit: base",
        "LastCode-Commit: source",
        "Upstream-Commit: \nLastCode-Commit: source",
        "Upstream-Commit: base\nLastCode-Commit: ",
      ]) {
        expectError(
          `${contents}\nReplay-Mode: invalid`,
          "tag is missing immutable carry-set metadata.",
          "different",
        );
      }
      expectError(
        `${metadata}\nReplay-Mode: invalid`,
        "tag metadata names source, but the tag resolves to different.",
        "different",
      );
      expectError(
        "Upstream-Commit: base\nLastCode-Commit: source ",
        "tag metadata names source , but the tag resolves to source.",
      );
    },
  );

  NodeTest.it("rejects blank, whitespace, case variants and unusual replay strings exactly", () => {
    for (const mode of [
      "",
      " ",
      "\t",
      "Carry",
      "CARRY",
      "Historical",
      "carry ",
      " carry",
      "historical\r",
      "carry\0",
      "😀",
      "\ud800",
      "undefined",
      "carry: historical",
    ]) {
      expectError(`${metadata}\nReplay-Mode: ${mode}`, "tag has an invalid Replay-Mode.");
    }
  });

  NodeTest.it("preserves unusual metadata strings and exact source identity", () => {
    for (const value of [" ", "\t", "\0", "😀", "\ud800", "base: source", "Source"]) {
      NodeAssert.deepEqual(
        carrySetShadowTarget(value, `Upstream-Commit: ${value}\nLastCode-Commit: ${value}`, value),
        { checkpointTag: value, baseCommit: value, sourceCommit: value },
      );
    }
  });
});
