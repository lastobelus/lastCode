import { assert, describe, it } from "@effect/vitest";

import { isSafeFeedArtifactName, parseHelperResult } from "./LastCodeLocalUpdates.ts";

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

  it("only serves updater artifacts from the build directory root", () => {
    assert.isTrue(isSafeFeedArtifactName("nightly-mac.yml"));
    assert.isTrue(isSafeFeedArtifactName("LastCode.zip"));
    assert.isTrue(isSafeFeedArtifactName("LastCode.zip.blockmap"));
    assert.isFalse(isSafeFeedArtifactName("latest-mac.yml"));
    assert.isFalse(isSafeFeedArtifactName("../nightly-mac.yml"));
    assert.isFalse(isSafeFeedArtifactName("nested/LastCode.zip"));
  });
});
