import { expect, it } from "@effect/vitest";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServerResponse } from "effect/http";

import { assetFileResponse } from "./http.ts";

const layerFileResponse = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

it.effect("keeps attachment media out of the cache once its signed URL expires", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attachment-media-" });
    const filePath = path.join(directory, "audio.wav");
    yield* fs.writeFileString(filePath, "RIFF");
    const canonicalPath = yield* fs.realPath(filePath);
    const response = HttpServerResponse.toWeb(
      yield* assetFileResponse({ path: canonicalPath, mimeType: "audio/wav" }),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  }).pipe(Effect.provide(layerFileResponse)),
);
