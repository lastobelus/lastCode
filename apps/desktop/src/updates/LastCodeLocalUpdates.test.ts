import { assert, describe, it } from "@effect/vitest";

import {
  parseHelperResult,
  terminateHelperProcess,
  usesDetachedHelperProcessGroup,
} from "./LastCodeLocalUpdates.ts";

describe("LastCodeLocalUpdates", () => {
  it("parses the helper's final structured result", () => {
    assert.deepEqual(
      parseHelperResult(
        'noise\nLASTCODE_LOCAL_UPDATE_RESULT={"schemaVersion":1,"status":"built"}\n',
      ),
      { schemaVersion: 1, status: "built" },
    );
    assert.throws(() => parseHelperResult("noise only"), /did not return a result/);
  });

  it("terminates the detached helper process group on macOS", () => {
    const groupSignals: Array<[number, NodeJS.Signals]> = [];
    let directKills = 0;

    assert.isTrue(usesDetachedHelperProcessGroup("darwin"));
    assert.isFalse(usesDetachedHelperProcessGroup("win32"));
    assert.isTrue(
      terminateHelperProcess(
        {
          pid: 4242,
          kill: () => {
            directKills += 1;
            return true;
          },
        },
        "darwin",
        (pid, signal) => {
          groupSignals.push([pid, signal]);
          return true;
        },
      ),
    );
    assert.deepEqual(groupSignals, [[-4242, "SIGKILL"]]);
    assert.equal(directKills, 0);
  });
});
