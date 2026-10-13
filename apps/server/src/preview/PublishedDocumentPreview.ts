import {
  PreviewAutomationPublishedDocumentError,
  type PreviewAutomationError,
  type PreviewAutomationMcpOpenInput,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpServer } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ThreadLinkedFiles from "../workspace/ThreadLinkedFiles.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AssetAccess from "../assets/AssetAccess.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

export class PublishedDocumentPreview extends Context.Service<
  PublishedDocumentPreview,
  {
    readonly open: (
      scope: McpInvocationContext.McpThreadInvocationScope,
      input: PreviewAutomationMcpOpenInput,
    ) => Effect.Effect<
      PreviewAutomationStatus,
      PreviewAutomationError | PreviewAutomationPublishedDocumentError
    >;
  }
>()("t3/preview/PublishedDocumentPreview") {}

const make = Effect.gen(function* () {
  // Asset access is the existing publication resolver and signer. Capture only
  // application services here; the calling thread is read afresh on every open.
  const assets = Context.make(FileSystem.FileSystem, yield* FileSystem.FileSystem).pipe(
    Context.add(Path.Path, yield* Path.Path),
    Context.add(Crypto.Crypto, yield* Crypto.Crypto),
    Context.add(HostProcess.HomeDirectory, yield* HostProcess.HomeDirectory),
    Context.add(ServerConfig.ServerConfig, yield* ServerConfig.ServerConfig),
    Context.add(ServerSecretStore.ServerSecretStore, yield* ServerSecretStore.ServerSecretStore),
    Context.add(Orchestrator.OrchestratorV2, yield* Orchestrator.OrchestratorV2),
    Context.add(
      ProjectFaviconResolver.ProjectFaviconResolver,
      yield* ProjectFaviconResolver.ProjectFaviconResolver,
    ),
    Context.add(ThreadLinkedFiles.ThreadLinkedFiles, yield* ThreadLinkedFiles.ThreadLinkedFiles),
    Context.add(WorkspacePaths.WorkspacePaths, yield* WorkspacePaths.WorkspacePaths),
  );
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const server = yield* HttpServer.HttpServer;

  const open: PublishedDocumentPreview["Service"]["open"] = Effect.fn(
    "PublishedDocumentPreview.open",
  )(function* (scope, input) {
    const { target, tabId, ...browserInput } = input;
    if (target === undefined) {
      return yield* new PreviewAutomationPublishedDocumentError({
        threadId: scope.thread.threadId,
        reason: "file-unavailable",
      });
    }
    const address = server.address;
    if (address._tag === "UnixPathAddress") {
      return yield* new PreviewAutomationPublishedDocumentError({
        threadId: scope.thread.threadId,
        reason: "http-unavailable",
      });
    }
    // Wildcard listeners are reached through loopback from the environment
    // browser. Specific interfaces retain their actual bound address.
    const boundHost = address.address.toString();
    const hostname = boundHost === "0.0.0.0" ? "127.0.0.1" : boundHost === "::" ? "::1" : boundHost;
    const host = hostname.includes(":") ? `[${hostname}]` : hostname;
    const asset = yield* AssetAccess.issueAssetUrl({
      resource: {
        _tag: "media-file",
        threadId: scope.thread.threadId,
        path: target.path,
        linkedThreadFile: true,
      },
    }).pipe(
      Effect.provide(assets),
      Effect.mapError(
        (cause) =>
          new PreviewAutomationPublishedDocumentError({
            threadId: scope.thread.threadId,
            reason: "file-unavailable",
            cause,
          }),
      ),
    );
    return yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation:
        input.profileId !== undefined || input.profileName !== undefined
          ? "openWithProfile"
          : "open",
      input: {
        ...browserInput,
        browserHost: "environment",
        url: new URL(asset.relativeUrl, `http://${host}:${address.port}`).href,
      },
      ...(tabId === undefined ? {} : { tabId }),
    });
  });
  return PublishedDocumentPreview.of({ open });
});

export const layer = Layer.effect(PublishedDocumentPreview, make);
