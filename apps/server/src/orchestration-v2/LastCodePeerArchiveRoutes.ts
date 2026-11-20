import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMcpClientAuthenticator } from "../auth/McpOAuth.ts";
import { PeerArchiveMutationHandler } from "../peer/LastCodePeerArchiveServices.ts";
import { writeRouteLayer } from "../peer/LastCodePeerArchiveTransport.ts";
import { CommandReceiptStoreV2, layerFromApplicationReceipts } from "./CommandReceiptStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { makeLastCodeArchiveJournal } from "./LastCodeArchiveJournal.ts";
import { makeLastCodePeerArchiveDestination } from "./LastCodePeerArchiveDestination.ts";
import { OrchestratorDispatchError, OrchestratorV2 } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const handler = Layer.effect(
  PeerArchiveMutationHandler,
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const threads = yield* ThreadManagementService;
    return yield* makeLastCodePeerArchiveDestination({
      journal: makeLastCodeArchiveJournal(yield* SqlClient.SqlClient),
      orchestrator: {
        dispatch: (command, options) =>
          command.type === "thread.archive"
            ? threads.dispatch(command, options).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
                Effect.timeoutOrElse({
                  duration: "1500 millis",
                  orElse: () =>
                    Effect.fail(
                      new OrchestratorDispatchError({
                        commandId: command.commandId,
                        commandType: command.type,
                        cause: "Linked archive is still processing.",
                      }),
                    ),
                }),
              )
            : orchestrator.dispatch(command, options),
      },
      eventSink: yield* EventSinkV2,
      receipts: yield* CommandReceiptStoreV2,
    });
  }),
);

export const layer = writeRouteLayer.pipe(
  Layer.provide(handler),
  Layer.provide(layerFromApplicationReceipts),
  Layer.provide(layerMcpClientAuthenticator),
);
