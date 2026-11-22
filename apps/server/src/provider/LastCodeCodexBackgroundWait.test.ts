import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import {
  buildCodexTurnStartParams,
  CODEX_DEFAULT_INSTANCE_ID,
  makeCodexAdapterV2,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES } from "./CodexDeveloperInstructions.ts";
import { readCodexBackgroundWait } from "./LastCodeCodexBackgroundWait.ts";

const defaultCodexSettings = Schema.decodeSync(CodexSettings)({});

it.effect("applies the environment's background wait setting to new Codex sessions", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const adapter = yield* makeCodexAdapterV2({
      instanceId: CODEX_DEFAULT_INSTANCE_ID,
      settings: defaultCodexSettings,
      environment: {},
      clientFactory: {
        open: () =>
          CodexClient.make(
            Stdio.make({
              args: Effect.succeed([]),
              stdin: Stream.never,
              stdout: () => Sink.drain,
              stderr: () => Sink.drain,
            }),
            {},
            Effect.never,
          ),
      },
      digest: yield* Digest.Digest,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* makeReplayServerConfig("lastcode-codex-background-wait"),
      readBackgroundWait: readCodexBackgroundWait(settings.getSettings),
    });
    const threadId = ThreadId.make("thread-background-wait");
    const modelSelection = { instanceId: CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" };
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
    });
    const open = (providerSessionId: string) =>
      adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(providerSessionId),
        modelSelection,
        runtimePolicy,
      });
    const before = yield* open("wait-disabled");
    NodeAssert.equal(before.awaitBackgroundTasks, undefined);
    yield* settings.updateSettings({ lastcodeCodexBackgroundWaitEnabled: true });
    const after = yield* open("wait-enabled");
    NodeAssert.equal(typeof after.awaitBackgroundTasks, "function");

    for (const session of [before, after]) {
      const enabled = session.awaitBackgroundTasks !== undefined;
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-background-wait",
        codexInput: [],
        modelSelection,
        runtimePolicy,
        hasT3Mcp: true,
        backgroundWaitAvailable: enabled,
      });
      const instructions = params.additionalContext?.t3_code_runtime?.value ?? "";
      NodeAssert.equal(instructions.includes("t3_background_wait"), enabled);
      NodeAssert.ok(
        Buffer.byteLength(instructions, "utf8") <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        McpProviderSessions.layer,
        IdAllocator.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
