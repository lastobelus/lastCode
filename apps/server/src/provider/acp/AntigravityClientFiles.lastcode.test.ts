import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import { readAntigravityClientTextFile } from "./AntigravityClientFiles.ts";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

describe("AntigravityClientFiles workspace aliases", () => {
  it.effect("resolves missing nested paths through a workspace alias before reading", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-workspace-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-antigravity-outside-",
      });
      const workspaceAlias = path.join(outside, "workspace-alias");
      yield* fileSystem.symlink(workspace, workspaceAlias);
      const nestedPath = path.join(workspaceAlias, "new", "nested", "inside.ts");
      const readTextFile = () =>
        readAntigravityClientTextFile({
          fileSystem,
          path,
          allowedRoots: [workspace],
          request: { sessionId: "mock-session-1", path: nestedPath },
        });
      const missingRead = yield* readTextFile().pipe(Effect.flip);
      assert.equal(
        isAcpRequestError(missingRead) && missingRead.code,
        EffectAcpErrors.AcpRequestError.resourceNotFound("missing").code,
      );
      yield* fileSystem.makeDirectory(path.join(workspace, "new", "nested"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(workspace, "new", "nested", "inside.ts"),
        "nested",
      );
      const nestedRead = yield* readTextFile();
      assert.equal(nestedRead.content, "nested");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
