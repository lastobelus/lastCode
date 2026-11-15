import * as NodeWS from "@effect/platform-node/NodeWS";
import { ORCHESTRATION_PROTOCOL_VERSION, WsRpcGroup } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { T3_HOME } from "../e2e.config.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const decodeSession = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String, token: Schema.String })),
);
const decodeRuntime = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
);

test(
  "Pause starts on one click and Resume works while threads are still pausing",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const { cli } = makeState(T3_HOME);
    const issued = await runPromise(cli(["auth", "session", "issue", "--json", "--ttl", "5m"]));
    const session = decodeSession(issued.stdout);
    const scope = await runPromise(Scope.make());
    try {
      const client = await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { origin } = yield* fs
            .readFileString(`${T3_HOME}/userdata/server-runtime.json`)
            .pipe(Effect.flatMap(decodeRuntime));
          const ticket = yield* HttpClient.execute(
            HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`).pipe(
              HttpClientRequest.bearerToken(session.token),
            ),
          ).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(Schema.Struct({ ticket: Schema.String })),
            ),
          );
          const protocol = yield* Layer.build(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(
                Socket.layerWebSocket(
                  `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
                ),
              ),
              Layer.provide(RpcSerialization.layerJson),
              Layer.provide(NodeWS.layerWebSocketConstructor),
            ),
          );
          const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
          yield* client["server.updateSettings"]({ patch: { environmentPauseEnabled: true } });
          return client;
        }).pipe(Scope.provide(scope), Effect.provide(FetchHttpClient.layer)),
      );
      const project = await t3.project("pause-demo");
      // An unanswered replay question keeps real work waiting without a timing delay.
      const thread = await t3.thread({
        project,
        title: "Waiting for an answer",
        messages: ["Ask me a question before continuing."],
        model: "question",
      });
      const status = () => runPromise(client["server.environmentPauseStatus"]({}));
      // Pairing leaves /pair before reloading its connection; wait for the app before navigating.
      await t3.open();
      await screen.getByRole("button", /^Pause /).waitFor({ state: "visible" });
      const { environment } = await runPromise(client["server.getConfig"]({}));
      await app.open(`/${environment.environmentId}/${thread.threadId}`);
      await screen.getByRole("button", /^Pause /).waitFor({ state: "visible" });
      // Public evidence uses a generic display name; requests keep the real environment identity.
      await browser.evaluate(async () => {
        const catalogPath = "/src/connection/catalog.ts";
        const registryPath = "/src/rpc/atomRegistry.ts";
        const presentationPath = "/src/state/presentation.ts";
        const serverPath = "/src/state/server.ts";
        const { environmentCatalog } = await import(catalogPath);
        const { appAtomRegistry } = await import(registryPath);
        const { environmentPresentations } = await import(presentationPath);
        const { serverEnvironment } = await import(serverPath);
        const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom) as {
          entries: Map<string, { target: { label: string } }>;
        };
        for (const [environmentId, entry] of catalog.entries) {
          // Replacing a live entry makes acquireSupervisor close its authenticated connection.
          entry.target.label = "workstation.example";
          const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)) as {
            environment: { label: string };
          } | null;
          if (config !== null)
            config.environment = { ...config.environment, label: "workstation.example" };
          appAtomRegistry.refresh(environmentPresentations.presentationAtom(environmentId));
        }
        appAtomRegistry.refresh(environmentPresentations.presentationsAtom);
        return null;
      });
      await screen.getByRole("button", "Pause workstation.example").waitFor({ state: "visible" });
      await app.screenshot("before-pause-click");

      await screen.getByRole("button", /^Pause /).tap();
      try {
        await expect(screen.getByRole("dialog")).toBeHidden();
        await expect(screen.getByText(/ · Pausing$/)).toBeVisible();
        expect((await status()).session?.phase).toBe("pausing");
      } finally {
        await app.screenshot("after-pause-click");
      }

      await screen.getByRole("button", /^Resume /).tap();
      try {
        await expect(screen.getByRole("dialog")).toBeHidden();
        await expect
          .poll(async () => {
            const { session } = await status();
            return session === null || session.phase === "resuming";
          })
          .toBe(true);
        await expect(screen.getByText(/ · Pausing$/)).toBeHidden();
      } finally {
        await app.screenshot("after-resume-click");
      }
    } finally {
      await runPromise(Scope.close(scope, Exit.void));
      await runPromise(cli(["auth", "session", "revoke", session.sessionId]));
    }
  },
);
