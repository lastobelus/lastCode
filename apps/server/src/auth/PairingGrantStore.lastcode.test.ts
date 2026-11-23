import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

const layerPairingGrantStore = () =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-bootstrap-test-" })),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("PairingGrantStore.layer", (it) => {
  it.effect.each([
    { label: "empty", requestedScopes: [] },
    { label: "ungranted", requestedScopes: ["access:write"] },
  ] as const)("preserves a one-time grant after an $label scope request", ({ requestedScopes }) =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken({
        scopes: ["orchestration:read"],
      });
      const rejected = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, { requestedScopes }),
      );
      expect(rejected._tag).toBe("BootstrapCredentialScopeNotGrantedError");

      const consumed = yield* bootstrapCredentials.consume(token.credential);
      expect(consumed.scopes).toEqual(["orchestration:read"]);
      const reused = yield* Effect.flip(bootstrapCredentials.consume(token.credential));
      expect(reused._tag).toBe("UnknownBootstrapCredentialError");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );
});
